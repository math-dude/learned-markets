"""Surfpool ledger launch preparation and confirmed batch settlement."""

import asyncio
import base64
import hashlib
import json
import os
import sqlite3
import struct
from pathlib import Path
from time import time

from fastapi import HTTPException
from learned_markets_core.state import MarketConfig
from learned_markets_core.units import tick_of_price
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
from .contracts import ClearRequest, Observation, Order, Person, PublicMarket
from .generated.accounts.config import Config
from .generated.accounts.intent import Intent
from .generated.accounts.ledgerBalance import LedgerBalance
from .generated.accounts.ledgerMarket import LedgerMarket
from .generated.accounts.ledgerPosition import LedgerPosition
from .generated.accounts.participant import Participant
from .generated.instructions.initializeLedgerPosition import InitializeLedgerPosition
from .generated.instructions.openLedgerMarket import OpenLedgerMarket
from .generated.instructions.registerParticipant import find_WalletBinding
from .live_lifecycle import STAGES, LiveLifecycle
from .policy import rule_quote

CONFIG = Pubkey.find_program_address([b"config"], PROGRAM_ID)[0]
PLATFORM = Pubkey.find_program_address([b"ledger-platform"], PROGRAM_ID)[0]
LAUNCH_FEE = 100_000_000
WINDOW = 32


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
        self.lock = asyncio.Lock()
        self.lifecycle = LiveLifecycle(self, CONFIG, WINDOW)

    def signer(self):
        path = Path(os.environ.get("LM_KEYS_DIR", "keys")) / "settlement-authority.json"
        return Keypair.from_json(path.read_text())

    async def launch(self, identity, name, ticker):
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
        if await LedgerMarket.fetch(self.rpc, market):
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
            self.db.execute("INSERT OR IGNORE INTO web_markets VALUES (?,?,?)", (str(market), name, ticker))
            self.db.execute(
                "INSERT OR REPLACE INTO wallet_messages VALUES (?,?,?)",
                (hashlib.sha256(bytes(tx.message)).hexdigest(), str(wallet), int(time() * 1000) + 120_000),
            )
        return {"market": str(market), "transactionBase64": base64.b64encode(bytes(tx)).decode()}

    async def reconcile(self):
        for row in self.db.execute("SELECT * FROM web_pending_tx").fetchall():
            sig = Signature.from_string(row["signature"])
            status = (await self.rpc.get_signature_statuses([sig], search_transaction_history=True)).value[0]
            result = json.loads(row["result"])
            if not status:
                if (await self.rpc.get_block_height()).value <= row["block_height"]:
                    await self.rpc.send_raw_transaction(
                        base64.b64decode(row["wire"]), TxOpts(preflight_commitment="confirmed")
                    )
                    continue
                error = "Transaction expired before confirmation."
            elif status.err:
                error = str(status.err)
            elif str(status.confirmation_status).split(".")[-1].lower() in ("confirmed", "finalized"):
                error = None
            else:
                continue
            with self.db:
                for fill in result["fills"]:
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
            seen = set()
            for group in groups:
                if group["market"] not in seen:
                    await self.settle(group["market"], group["batch"])
                    seen.add(group["market"])
            await self.lifecycle.advance(slot)

    async def settle(self, address, batch):
        market = Pubkey.from_string(address)
        m = await LedgerMarket.fetch(self.rpc, market)
        rows = self.db.execute(
            """SELECT a.* FROM web_orders w JOIN admitted_intents a USING(intent)
            WHERE w.market=? AND w.batch=? AND w.status='queued' ORDER BY a.admitted_at,a.intent""",
            (address, batch),
        ).fetchall()
        people, orders, traders, setup = [], [], {}, []
        authority = self.signer()
        cfg = await Config.fetch(self.rpc, CONFIG)
        if not cfg or cfg.settlementAuthority != authority.pubkey():
            return
        for row in rows:
            who = row["participant"]
            person = Pubkey.from_string(who)
            intent = await Intent.fetch(self.rpc, Pubkey.from_string(row["intent"]))
            contents = bytes.fromhex(row["contents_hex"])
            reason = None
            if not m or not m.live or (m.lastBatchId is not None and batch <= m.lastBatchId):
                reason = "Market or batch closed."
            elif not intent or intent.state.to_json()["kind"] != "Open" or intent.deadline <= time():
                reason = "Intent expired or closed."
            elif who in traders or len(orders) == 8:
                reason = "Batch participant limit reached."
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
            pos = await LedgerPosition.fetch(self.rpc, pos_key)
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
        req = ClearRequest(
            market=public, quote=rule_quote(Observation(market=public)), people=people, user_curves=orders
        )
        result = clear(req)
        filled = {f["intent"] for f in result["fills"]}
        with self.db:
            for order in orders:
                if order.intent not in filled:
                    self.db.execute(
                        "UPDATE web_orders SET status='unfilled',details='No executable volume at the clearing price.' WHERE intent=?",
                        (order.intent,),
                    )
        if not filled:
            return
        ix = settlement_instruction(
            req, result, market, authority.pubkey(), CONFIG, cfg.credential, cfg.schema, cfg.schemaMint, traders
        )
        participants = {f["participant"] for f in result["fills"]}
        block = (await self.rpc.get_latest_blockhash()).value
        tx = Transaction.new_signed_with_payer(
            [i for who, i in setup if who in participants] + [ix], authority.pubkey(), [authority], block.blockhash
        )
        wire = bytes(tx)
        if len(wire) > 1232:
            with self.db:
                for key in filled:
                    self.db.execute(
                        "UPDATE web_orders SET status='closed',details='Batch exceeds the Solana packet limit.' WHERE intent=?",
                        (key,),
                    )
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
