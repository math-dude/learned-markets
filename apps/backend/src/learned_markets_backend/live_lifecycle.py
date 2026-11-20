"""Persisted demo board using the simulator's lifecycle and confirmed fill counts."""

import json
import time
from types import SimpleNamespace

import torch
from learned_markets_core.lifecycle import (
    default_lever_values,
    levers_from_values,
    lifecycle_step,
)
from learned_markets_core.state import LINE, MarketConfig, MarketState
from solana.rpc.types import TxOpts
from solders.instruction import AccountMeta
from solders.pubkey import Pubkey
from solders.transaction import Transaction

from .chain import ledger_balance_address
from .generated.accounts.ledgerMarket import LedgerMarket
from .generated.instructions.closeLedgerMarket import CloseLedgerMarket, find_Platform

# Accelerated Surfpool demonstration profile. Timers are activity units.
PROFILE = {
    "epoch": 12,
    "cut_round": 6,
    "grace": 24,
    "timer_init": 120.0,
    "seat_min_heat": 2.0,
    "graduation_activity": 12.0,
}
STAGES = {0: "Ended", 1: "Line", 2: "Rookie", 3: "Regular"}
FIELDS = ("stage", "birth", "heat", "timer", "activity", "coin_id")
# Survivors paid per close; the program accepts up to 8 pairs.
MAX_SURVIVORS = 6


def close_split(total, survivors):
    """Mirror of the program's split: (per survivor, per deployer, platform)."""
    if survivors == 0:
        return 0, 0, total
    each, dep = total * 6_000 // 10_000 // survivors, total * 2_000 // 10_000 // survivors
    return each, dep, total - (each + dep) * survivors


def rank_survivors(coins, closing):
    """Live coins other than `closing`, highest stage first, then most active."""
    alive = [c for c in coins if c["stage"] and c["address"] != closing]
    return sorted(alive, key=lambda c: (-c["stage"], -c["activity"], -c["heat"]))


def step_board(coins, batch, counts):
    cfg = MarketConfig(n_worlds=1, n_slots=max(1, len(coins)), n_people=1, **PROFILE)
    state = MarketState.empty(cfg)
    state.t = batch
    for i, coin in enumerate(coins):
        for field in FIELDS:
            getattr(state, field)[0, i] = coin[field]
    values = default_lever_values(cfg)
    values[:, 5] = 300
    result = lifecycle_step(
        state,
        SimpleNamespace(traders=torch.tensor([[counts.get(c["address"], 0) for c in coins]])),
        levers_from_values(values),
        torch.tensor([False]),
        torch.tensor([0]),
        cfg,
    )
    updated = []
    for i, coin in enumerate(coins):
        item = dict(coin)
        for field in FIELDS:
            item[field] = getattr(state, field)[0, i].item()
        if result.ended[0, i]:
            item["ended_reason"] = {1: "Cut", 2: "Dead", 3: "Bumped"}[int(result.reason[0, i])]
        updated.append(item)
    return updated


class LiveLifecycle:
    def __init__(self, engine, config_address, window):
        self.engine, self.config, self.window = engine, config_address, window
        engine.db.execute(
            "CREATE TABLE IF NOT EXISTS web_lifecycle (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)"
        )
        engine.db.execute(
            """CREATE TABLE IF NOT EXISTS web_flows (batch INTEGER NOT NULL, market TEXT NOT NULL, ticker TEXT,
            total INTEGER NOT NULL, survivors TEXT NOT NULL, deployers_amount INTEGER NOT NULL,
            platform_amount INTEGER NOT NULL, signature TEXT, ts REAL NOT NULL)"""
        )

    async def close_market(self, batch, market, chain, coins):
        """Close `market`, paying its reserve to the top live survivors, their deployers and the platform."""
        engine, db = self.engine, self.engine.db
        pairs, paid = [], []
        for coin in rank_survivors(coins, str(market)):
            if len(paid) == MAX_SURVIVORS:
                break
            key = Pubkey.from_string(coin["address"])
            survivor = await LedgerMarket.fetch(engine.rpc, key)
            if not survivor or not survivor.live:
                continue
            pairs += [
                AccountMeta(key, is_signer=False, is_writable=True),
                AccountMeta(ledger_balance_address(survivor.deployer), is_signer=False, is_writable=True),
            ]
            paid.append(coin["address"])
        authority = engine.signer()
        ix = CloseLedgerMarket(
            {
                "settlementAuthority": authority.pubkey(),
                "config": self.config,
                "market": market,
                "platform": find_Platform()[0],
            },
            remaining_accounts=pairs,
        )
        block = (await engine.rpc.get_latest_blockhash()).value
        tx = Transaction.new_signed_with_payer([ix], authority.pubkey(), [authority], block.blockhash)
        sent = await engine.rpc.send_transaction(
            tx,
            TxOpts(
                skip_confirmation=False,
                preflight_commitment="confirmed",
                last_valid_block_height=block.last_valid_block_height,
            ),
        )
        total = chain.reserveCash
        each, dep, platform = close_split(total, len(paid))
        tickers = {r["address"]: r["ticker"] for r in db.execute("SELECT address,ticker FROM web_markets")}
        survivors = [{"address": a, "ticker": tickers.get(a), "amount": each} for a in paid]
        with db:
            db.execute(
                "INSERT INTO web_flows VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    batch,
                    str(market),
                    tickers.get(str(market)),
                    total,
                    json.dumps(survivors),
                    dep * len(paid),
                    platform,
                    str(sent.value),
                    time.time(),
                ),
            )

    def snapshot(self):
        row = self.engine.db.execute("SELECT snapshot FROM web_lifecycle WHERE id=1").fetchone()
        return json.loads(row[0]) if row else None

    async def advance(self, slot):
        engine, db = self.engine, self.engine.db
        target = slot // self.window - 1
        # Finish every earlier admitted batch before using its participation count.
        if db.execute(
            "SELECT 1 FROM web_orders WHERE batch<=? AND status IN ('queued','confirming') LIMIT 1", (target,)
        ).fetchone():
            return
        board = self.snapshot() or {"batch": target, "coins": []}
        known = {c["address"] for c in board["coins"]}
        for row in db.execute("SELECT address FROM web_markets").fetchall():
            if row["address"] in known:
                continue
            account = await LedgerMarket.fetch(engine.rpc, Pubkey.from_string(row["address"]))
            if not account or not account.live:
                continue
            board["coins"].append(
                {
                    "address": row["address"],
                    "stage": LINE,
                    "birth": target,
                    "heat": 0.0,
                    "timer": 0.0,
                    "activity": 0.0,
                    "coin_id": len(known) + 1,
                }
            )
            known.add(row["address"])
        # Do not replay unbounded downtime in a single worker iteration.
        for batch in range(board["batch"] + 1, min(target, board["batch"] + 240) + 1):
            counts = {}
            participants = {}
            for row in db.execute("SELECT market,details FROM web_orders WHERE batch=? AND status='filled'", (batch,)):
                fill = json.loads(row["details"])
                if (
                    int(fill.get("clearing_price", 0)) * int(fill["quantity"]) // 1_000_000
                    >= MarketConfig().dust_lamports
                ):
                    participants.setdefault(row["market"], set()).add(fill["participant"])
            counts = {key: len(value) for key, value in participants.items()}
            updated = step_board(board["coins"], batch, counts) if board["coins"] else []
            for old, new in zip(board["coins"], updated, strict=True):
                if old["stage"] and not new["stage"]:
                    market = Pubkey.from_string(new["address"])
                    chain = await LedgerMarket.fetch(engine.rpc, market)
                    if chain and chain.live:
                        await self.close_market(batch, market, chain, updated)
                    # A retry after a crash also accepts a market already closed on chain.
            board = {"batch": batch, "coins": updated}
            with db:
                db.execute("INSERT OR REPLACE INTO web_lifecycle VALUES (1,?)", (json.dumps(board),))
        with db:
            db.execute("INSERT OR REPLACE INTO web_lifecycle VALUES (1,?)", (json.dumps(board),))
