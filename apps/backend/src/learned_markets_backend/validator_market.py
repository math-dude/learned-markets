"""Surfpool ledger launch preparation and confirmed batch settlement."""

import asyncio
import base64
import copy
import hashlib
import json
import logging
import os
import sqlite3
import struct
from pathlib import Path
from time import time

import torch
from fastapi import HTTPException
from learned_markets_core.lifecycle import default_lever_values
from learned_markets_core.quoter import build_quote, residual_params, rule_based_params
from learned_markets_core.state import LINE, MarketConfig, MarketState
from learned_markets_core.tape import _SERIES, Tape
from learned_markets_core.units import tick_of_price
from solana.exceptions import SolanaRpcException
from solana.rpc.core import RPCException
from solana.rpc.types import TxOpts
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.system_program import ID as SYSTEM
from solders.transaction import Transaction
from spl.token.constants import TOKEN_2022_PROGRAM_ID
from spl.token.instructions import get_associated_token_address

from .chain import (
    PROGRAM_ID,
    TraderAccounts,
    ledger_balance_address,
    ledger_market_address,
    ledger_position_address,
    settlement_instruction,
)
from .clearing import clear
from .contracts import ClearRequest, Order, Person, PublicMarket, Quote
from .generated.accounts.config import Config
from .generated.accounts.intent import Intent
from .generated.accounts.ledgerBalance import LedgerBalance
from .generated.accounts.ledgerMarket import LedgerMarket
from .generated.accounts.ledgerPosition import LedgerPosition
from .generated.accounts.participant import Participant
from .generated.instructions.initializeLedgerPosition import InitializeLedgerPosition
from .generated.instructions.openLedgerMarket import OpenLedgerMarket
from .generated.instructions.registerParticipant import find_WalletBinding
from .live_lifecycle import FIELDS, PROFILE, STAGES, LiveLifecycle
from .policy import state_for
from .quoter_net import load_policy

CONFIG = Pubkey.find_program_address([b"config"], PROGRAM_ID)[0]
PLATFORM = Pubkey.find_program_address([b"ledger-platform"], PROGRAM_ID)[0]
LAUNCH_FEE = 100_000_000
# Settlement window in slots. Surfpool demos shorten it through LM_BATCH_SLOTS.
WINDOW = int(os.environ.get("LM_BATCH_SLOTS", "32"))
# Orders cleared per market per settlement (program max 8), and seconds of deadline headroom required.
BATCH_ORDERS = min(8, int(os.environ.get("LM_BATCH_ORDERS", "8")))
EXPIRY_MARGIN = float(os.environ.get("LM_EXPIRY_MARGIN", "15"))
IDLE_SCALE = min(1.0, WINDOW * 0.4 / 10)
ASK_SHIFT = int(os.environ.get("LM_ASK_SHIFT", "0"))
PRESSURE_TRADERS = int(os.environ.get("LM_PRESSURE_TRADERS", "3"))


async def maybe_fetch(cls, rpc, address, seconds=3.0):
    """Read an account that may not exist yet.

    A forked Surfpool asks its remote datasource about absent accounts, which can stall
    for many seconds under rate limits. A timeout is treated as absent; the program
    still rejects a transaction whose account assumptions are wrong.
    """
    try:
        return await asyncio.wait_for(cls.fetch(rpc, address), seconds)
    except TimeoutError:
        return None


class ValidatorMarket:
    def __init__(self, rpc, database):
        self.rpc = rpc
        self.db = sqlite3.connect(database, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS web_markets (address TEXT PRIMARY KEY, name TEXT NOT NULL, ticker TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS web_orders (intent TEXT PRIMARY KEY, market TEXT NOT NULL, batch INTEGER NOT NULL,
            status TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', signature TEXT);
        CREATE TABLE IF NOT EXISTS web_pending_tx (signature TEXT PRIMARY KEY, market TEXT NOT NULL, wire TEXT NOT NULL,
            block_height INTEGER NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS web_hold_terms (market TEXT, participant TEXT, terms TEXT NOT NULL, PRIMARY KEY(market,participant));
        """)
        if "image" not in {r[1] for r in self.db.execute("PRAGMA table_info(web_markets)")}:
            self.db.execute("ALTER TABLE web_markets ADD COLUMN image TEXT")
        self.lock = asyncio.Lock()
        self.lifecycle = LiveLifecycle(self, CONFIG, WINDOW)
        # LM_QUOTER names an exported quoter.pt; without it the fixed rule quotes alone.
        path = os.environ.get("LM_QUOTER")
        self.policy = load_policy(path) if path else None
        logging.getLogger("uvicorn.error").info("Quoter: %s", path or "fixed rule")
        # Public tape per market, as the simulator keeps it: address -> (Tape, last cleared batch).
        self.tapes = {}

    def tape_for(self, address, public):
        """A working copy of the market's tape with idle batches since its last clearing counted."""
        entry = self.tapes.get(address)
        if not entry:
            return Tape(state_for(public)[1])
        tape = copy.deepcopy(entry[0])
        # The quoter was trained on 10 s batches; shorter demo windows count as fractions of one.
        tape.idle = tape.idle + max(0, public.batch_id - entry[1] - 1) * IDLE_SCALE
        return tape

    def observation(self, address, public, board, tape):
        """The trained quoter's view of one coin: the simulator's observation over the live board."""
        coins = [c for c in board["coins"] if c["stage"]]
        if all(c["address"] != address for c in coins):
            coins.append({"address": address, "stage": LINE, "birth": public.batch_id, "heat": 0.0,
                          "timer": 0.0, "activity": 0.0, "coin_id": 0})  # fmt: skip
        cfg = MarketConfig(n_worlds=1, n_slots=len(coins), n_people=1, **PROFILE)
        state, wide = MarketState.empty(cfg), Tape(cfg)
        state.t = public.batch_id
        for i, coin in enumerate(coins):
            for field in FIELDS:
                getattr(state, field)[0, i] = coin[field]
            mine = coin["address"] == address
            known = tape if mine else self.tapes.get(coin["address"], (None,))[0]
            if known is not None:
                for name in (*_SERIES, "logp", "traders_last"):
                    getattr(wide, name)[0, i] = getattr(known, name)[0, 0]
            if mine:
                at = i
                state.tick[0, i], state.q_cash[0, i], state.q_tokens[0, i] = (
                    public.tick, public.reserve_cash, public.reserve_tokens)  # fmt: skip
        values = default_lever_values(cfg)
        values[:, 5] = 300
        return wide.observation(state, values)[0, at].unsqueeze(0)

    def quote(self, address, public, board, tape):
        """Next batch's curve: the rule on this market's tape, corrected by the trained quoter when loaded."""
        state, cfg = state_for(public)
        # The rule moves its ask up to three ticks on last batch's unfilled side. With one or two
        # orders in a batch that reading is all-or-nothing and the ask chases every partial fill,
        # so it only counts once a batch has a crowd, as the batches the rule was tuned on do.
        pressure = torch.where(tape.traders_last >= PRESSURE_TRADERS, tape.pressure, torch.zeros_like(tape.pressure))
        if self.policy is None:
            params = rule_based_params(state, pressure, cfg, tape.idle)
        else:
            action = self.policy(self.observation(address, public, board, tape))
            params = residual_params(state, pressure, tape.idle, action, cfg)
        # The rule quotes its ask at the last price and its bid two ticks under it. That suits batches
        # with many traders on both sides; a live batch often holds one order, which then prints at the
        # ask (no change) or at the bid (two ticks down), so prices only ratchet down. LM_ASK_SHIFT
        # lifts the ask by that many ticks; 1 centres the spread on the last price.
        params[..., 3] = (params[..., 3] + ASK_SHIFT).clamp(-16, 16)
        quote = build_quote(state, params, cfg)
        return Quote(
            centre_tick=public.tick,
            bid=quote.bid[0].tolist(),
            ask=quote.ask[0].tolist(),
            cap_share=float(quote.cap_share[0, 0]),
            fee0=float(quote.fee0[0, 0]),
            half_life=float(quote.half_life[0, 0]),
            slope=float(quote.slope[0, 0]),
        )

    def signer(self):
        path = Path(os.environ.get("LM_KEYS_DIR", "keys")) / "settlement-authority.json"
        return Keypair.from_json(path.read_text())

    async def launch(self, identity, name, ticker, image=None):
        wallet, participant = (
            Pubkey.from_string(identity["wallet"]),
            Pubkey.from_string(identity["participant"]["address"]),
        )
        authority = self.signer()
        cfg = await Config.fetch(self.rpc, CONFIG)
        if not cfg or cfg.settlementAuthority != authority.pubkey():
            raise HTTPException(503, "Settlement authority is unavailable.")
        balance = await LedgerBalance.fetch(self.rpc, ledger_balance_address(participant))
        if not balance or balance.cash < LAUNCH_FEE:
            raise HTTPException(409, "Your validator trading balance is below the 0.1 SOL launch fee.")
        # Commit both visible labels into the immutable market identifier.
        market_id = Pubkey.from_bytes(
            hashlib.sha256(b"lm/launch/v1\0" + ticker.encode() + b"\0" + name.encode()).digest()
        )
        market = ledger_market_address(market_id)[0]
        if await maybe_fetch(LedgerMarket, self.rpc, market):
            raise HTTPException(409, "This coin already exists.")
        ix = OpenLedgerMarket(
            {"marketId": market_id, "launchFee": LAUNCH_FEE},
            {
                "wallet": wallet,
                "settlementAuthority": authority.pubkey(),
                "config": CONFIG,
                "participant": participant,
                "balance": ledger_balance_address(participant),
                "market": market,
                "platform": PLATFORM,
                "systemProgram": SYSTEM,
            },
        )
        block = (await self.rpc.get_latest_blockhash()).value.blockhash
        tx = Transaction.new_unsigned(Message.new_with_blockhash([ix], wallet, block))
        tx.partial_sign([authority], block)
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO web_markets(address,name,ticker,image) VALUES (?,?,?,?)",
                (str(market), name, ticker, image),
            )
            self.db.execute(
                "INSERT OR REPLACE INTO wallet_messages VALUES (?,?,?)",
                (hashlib.sha256(bytes(tx.message)).hexdigest(), str(wallet), int(time() * 1000) + 120_000),
            )
        return {"market": str(market), "transactionBase64": base64.b64encode(bytes(tx)).decode()}

    async def reconcile(self):
        rows = self.db.execute("SELECT * FROM web_pending_tx").fetchall()
        if not rows:
            return
        # One status read per 256 pending settlements instead of one per transaction.
        sigs = [Signature.from_string(row["signature"]) for row in rows]
        statuses = []
        for i in range(0, len(sigs), 256):
            statuses += (
                await self.rpc.get_signature_statuses(sigs[i : i + 256], search_transaction_history=True)
            ).value
        height = (await self.rpc.get_block_height()).value
        for row, sig, status in zip(rows, sigs, statuses, strict=True):
            result = json.loads(row["result"])
            retry = False
            if not status:
                if height <= row["block_height"]:
                    try:
                        await self.rpc.send_raw_transaction(
                            base64.b64decode(row["wire"]), TxOpts(preflight_commitment="confirmed")
                        )
                        continue
                    except RPCException as exc:
                        text = str(exc)
                        if "already been processed" in text:
                            continue
                        # The validator rejected it, so it can never land: free the market now
                        # instead of resending until the blockhash expires.
                        retry = "0x179d" in text or "IntentExpired" in text or "Blockhash not found" in text
                        error = "Settlement rejected: " + text[:300]
                    except SolanaRpcException:
                        # Transport trouble: it may still land, look again next poll.
                        logging.getLogger(__name__).warning("Resend of %s did not complete", sig)
                        continue
                else:
                    retry = True
                    error = "Transaction expired before confirmation."
            elif status.err:
                error = str(status.err)
            elif str(status.confirmation_status).split(".")[-1].lower() in ("confirmed", "finalized"):
                error = None
            else:
                continue
            with self.db:
                for fill in result["fills"]:
                    if retry:
                        # Never landed: clear these orders again; settle() closes the expired ones.
                        self.db.execute(
                            "UPDATE web_orders SET status='queued' WHERE intent=? AND status='confirming'",
                            (fill["intent"],),
                        )
                        continue
                    self.db.execute(
                        "UPDATE web_orders SET status=?,details=?,signature=? WHERE intent=?",
                        (
                            "failed" if error else "filled",
                            error or json.dumps({**fill, "clearing_price": result["clearing_price"]}),
                            str(sig),
                            fill["intent"],
                        ),
                    )
                if not error:
                    for person in result["after"]["people"]:
                        self.db.execute(
                            "INSERT OR REPLACE INTO web_hold_terms VALUES (?,?,?)",
                            (
                                row["market"],
                                person["participant"],
                                json.dumps({k: person[k] for k in ("buy_time", "lock_fee", "lock_half")}),
                            ),
                        )
                self.db.execute("DELETE FROM web_pending_tx WHERE signature=?", (str(sig),))

    async def advance(self):
        async with self.lock:
            await self.reconcile()
            slot = (await self.rpc.get_slot()).value
            # The gate has durably verified the signed payload against the live intent.
            with self.db:
                self.db.execute(
                    """INSERT OR IGNORE INTO web_orders(intent,market,batch,status)
                    SELECT intent,target,CAST(observed_slot AS INTEGER)/?, 'queued' FROM admitted_intents
                    WHERE kind=0 AND target IN (SELECT address FROM web_markets)""",
                    (WINDOW,),
                )
            groups = self.db.execute(
                """SELECT market, batch FROM web_orders WHERE status='queued'
                AND batch < ? AND market NOT IN (SELECT market FROM web_pending_tx) GROUP BY market,batch ORDER BY batch""",
                (slot // WINDOW,),
            ).fetchall()
            # Markets settle independently and concurrently. Each market clears everything
            # that is due under its newest due batch id, so a backlog drains instead of
            # trailing one window per poll until the intents expire.
            first = {}
            for group in groups:
                first[group["market"]] = group["batch"]
            gate = asyncio.Semaphore(int(os.environ.get("LM_SETTLE_CONCURRENCY", "16")))

            async def one(market, batch):
                async with gate:
                    try:
                        await self.settle(market, batch)
                    except Exception:
                        logging.getLogger(__name__).exception("Settlement of %s batch %s", market, batch)

            await asyncio.gather(*(one(m, b) for m, b in first.items()))
            await self.lifecycle.advance(slot)

    async def settle(self, address, batch):
        market = Pubkey.from_string(address)
        m = await LedgerMarket.fetch(self.rpc, market)
        if m and m.live and m.lastBatchId is not None and batch <= m.lastBatchId:
            # Orders that arrived after their window settled ride the next one.
            with self.db:
                self.db.execute(
                    "UPDATE web_orders SET batch=? WHERE market=? AND batch<=? AND status='queued'",
                    (m.lastBatchId + 1, address, batch),
                )
            return
        rows = self.db.execute(
            """SELECT a.* FROM web_orders w JOIN admitted_intents a USING(intent)
            WHERE w.market=? AND w.batch<=? AND w.status='queued' ORDER BY a.admitted_at,a.intent""",
            (address, batch),
        ).fetchall()
        # Intents past their deadline close without a chain read; the margin keeps a
        # settlement from expiring between clearing and landing.
        cutoff = time() + EXPIRY_MARGIN
        stale = [row["intent"] for row in rows if int(row["deadline"]) <= cutoff]
        if stale:
            with self.db:
                self.db.executemany(
                    "UPDATE web_orders SET status='closed',details='Intent expired or closed.' WHERE intent=?",
                    [(key,) for key in stale],
                )
            rows = [row for row in rows if int(row["deadline"]) > cutoff]
        waiting = []
        people, orders, traders, setup = [], [], {}, []
        authority = self.signer()
        cfg = await Config.fetch(self.rpc, CONFIG)
        if not cfg or cfg.settlementAuthority != authority.pubkey():
            return
        for row in rows:
            who = row["participant"]
            person = Pubkey.from_string(who)
            if m and m.live and (who in traders or len(orders) == BATCH_ORDERS):
                # One curve per person per batch: later orders wait for the next batch.
                waiting.append(row["intent"])
                continue
            intent = await Intent.fetch(self.rpc, Pubkey.from_string(row["intent"]))
            contents = bytes.fromhex(row["contents_hex"])
            reason = None
            if not m or not m.live or (m.lastBatchId is not None and batch <= m.lastBatchId):
                reason = "Market or batch closed."
            elif not intent or intent.state.to_json()["kind"] != "Open" or intent.deadline <= cutoff:
                reason = "Intent expired or closed."
            participant = await Participant.fetch(self.rpc, person) if not reason else None
            if participant and (
                participant.status.to_json()["kind"] != "Active" or str(participant.currentWallet) != row["wallet"]
            ):
                reason = "Participant is no longer eligible."
            balance = await LedgerBalance.fetch(self.rpc, ledger_balance_address(person)) if participant else None
            if not balance or not participant:
                reason = reason or "No validator trading balance."
            if reason:
                with self.db:
                    self.db.execute(
                        "UPDATE web_orders SET status='closed',details=? WHERE intent=?", (reason, row["intent"])
                    )
                continue
            pos_key = ledger_position_address(market, person)
            pos = await maybe_fetch(LedgerPosition, self.rpc, pos_key)
            wallet = participant.currentWallet
            traders[who] = TraderAccounts(
                person,
                find_WalletBinding(wallet)[0],
                participant.currentAttestation,
                participant.currentBadgeMint,
                get_associated_token_address(wallet, participant.currentBadgeMint, TOKEN_2022_PROGRAM_ID),
            )
            terms = self.db.execute(
                "SELECT terms FROM web_hold_terms WHERE market=? AND participant=?", (address, who)
            ).fetchone()
            people.append(
                Person(
                    participant=who,
                    cash=balance.cash,
                    tokens=pos.tokens if pos else 0,
                    **(json.loads(terms[0]) if terms else {}),
                )
            )
            curve = [{"price": p, "quantity": q} for p, q in struct.iter_unpack("<QQ", contents[3:])]
            orders.append(
                Order(intent=row["intent"], participant=who, side="sell" if contents[1] else "buy", curve=curve)
            )
            if not pos:
                setup.append(
                    (
                        who,
                        InitializeLedgerPosition(
                            {
                                "payer": authority.pubkey(),
                                "market": market,
                                "participant": person,
                                "position": pos_key,
                                "systemProgram": SYSTEM,
                            }
                        ),
                    )
                )
        with self.db:
            self.db.executemany("UPDATE web_orders SET batch=? WHERE intent=?", [(batch + 1, key) for key in waiting])
        if not orders:
            return
        board = self.lifecycle.snapshot() or {"coins": []}
        life = next((c for c in board["coins"] if c["address"] == address), None)
        public = PublicMarket(
            tick=tick_of_price(m.lastPrice) if m.lastPrice else MarketConfig().launch_tick,
            stage=STAGES[life["stage"]] if life and life["stage"] else "Line",
            reserve_cash=m.reserveCash,
            reserve_tokens=m.reserveTokens,
            timer=life["timer"] if life else 0.0,
            batch_id=batch,
        )
        base = self.tape_for(address, public)
        quote = self.quote(address, public, board, base)
        block = (await self.rpc.get_latest_blockhash()).value
        while True:
            tape = copy.deepcopy(base)
            req = ClearRequest(market=public, quote=quote, people=people, user_curves=orders)
            result = clear(req, tape)
            filled = {f["intent"] for f in result["fills"]}
            if not filled:
                break
            ix = settlement_instruction(
                req, result, market, authority.pubkey(), CONFIG, cfg.credential, cfg.schema, cfg.schemaMint, traders
            )
            participants = {f["participant"] for f in result["fills"]}
            tx = Transaction.new_signed_with_payer(
                [i for who, i in setup if who in participants] + [ix], authority.pubkey(), [authority], block.blockhash
            )
            wire = bytes(tx)
            if len(wire) <= 1232:
                break
            if len(orders) == 1:
                with self.db:
                    self.db.execute(
                        "UPDATE web_orders SET status='closed',details='Batch exceeds the Solana packet limit.' WHERE intent=?",
                        (orders[0].intent,),
                    )
                return
            # Too many traders for one packet: the latest order rides the next batch; clear the rest again.
            late = orders.pop()
            people = [p for p in people if p.participant != late.participant]
            with self.db:
                self.db.execute("UPDATE web_orders SET batch=? WHERE intent=?", (batch + 1, late.intent))
        with self.db:
            for order in orders:
                if order.intent not in filled:
                    self.db.execute(
                        "UPDATE web_orders SET status='unfilled',details='No executable volume at the clearing price.' WHERE intent=?",
                        (order.intent,),
                    )
        self.tapes[address] = (tape, batch)
        if not filled:
            return
        with self.db:
            self.db.execute(
                "INSERT INTO web_pending_tx VALUES (?,?,?,?,?)",
                (
                    str(tx.signatures[0]),
                    address,
                    base64.b64encode(wire).decode(),
                    block.last_valid_block_height,
                    json.dumps(result),
                ),
            )
            for key in filled:
                self.db.execute("UPDATE web_orders SET status='confirming' WHERE intent=?", (key,))
        await self.rpc.send_raw_transaction(wire, TxOpts(preflight_commitment="confirmed"))
