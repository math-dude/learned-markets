"""Single-worker, in-memory paper market for the React client."""

import asyncio
import os
import secrets
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from time import time
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Request, Response
from learned_markets_core import BUY, MarketConfig
from learned_markets_core.units import SUPPLY
from pydantic import Field, StringConstraints

from .auctioneer import Auctioneer
from .contracts import Contract
from .quoter_net import load_policy
from .web_gate import Gate, nomination_intent, trade_intent

COOKIE = "lm_paper_session"
STARTING_CASH = 2_000_000_000
BATCH_SECONDS = 8
SEED = (("Dog in Hat", "DOG"), ("Cat in Box", "CAT"), ("Moon Toast", "TOAST"))


class RequestForBatch(Contract):
    intent: str | None = Field(default=None, min_length=32, max_length=44)
    batch_id: int = Field(ge=0)


class LimitOrder(RequestForBatch):
    coin_id: int = Field(gt=0)
    side: Literal["buy", "sell"]
    quantity: int = Field(gt=0, le=SUPPLY)
    limit_price: int = Field(gt=0, le=2**53 - 1)


class Launch(RequestForBatch):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=32)]
    ticker: str = Field(pattern=r"^[A-Z0-9]{2,6}$")


class PaperRoom:
    def __init__(self, interval: float, policy=None):
        self.room_id = secrets.token_hex(16)
        self.interval = interval
        # Shorter epochs and a lower seating threshold make the lifecycle visible in a local demo.
        self.market = Auctioneer(MarketConfig(n_slots=12, n_people=128, epoch=12, seat_min_heat=0.8), policy)
        self.sessions: dict[str, int] = {}
        self.labels: dict[int, tuple[str, str]] = {}
        self.pending_launch: tuple[str, str] | None = None
        self.recent = deque(maxlen=128)
        self.receipts: dict[int, deque] = defaultdict(lambda: deque(maxlen=24))
        self.terms = self.market.begin_batch()
        self.market.credit(0, 10_000_000_000)
        for name, ticker in SEED:
            self.launch(0, name, ticker)
            self.advance()
        # One genuine fill qualifies DOG for a rookie seat at the first epoch.
        self.market.submit(0, 0, "buy", [(2 * self.terms["coins"][0]["last_price"], 1_000_000)])
        while self.market.state.t < self.market.cfg.epoch:
            self.advance()

    def advance(self):
        market = self.market
        old_ids = {c["slot"]: c["coin_id"] for c in self.terms["coins"]}
        pending = list(market.pending)
        deployer = market.launch_by
        result = market.clear()
        batch = result["batch_id"]
        fills = {}
        for record in result["records"]:
            coin = old_ids[record["slot"]]
            for fill in record["fills"]:
                entry = {
                    "batch_id": batch,
                    "coin_id": coin,
                    "ticker": self.labels[coin][1],
                    "side": fill["side"],
                    "quantity": fill["quantity"],
                    "price": record["clearing_price"],
                    "fee": fill["fee"],
                }
                self.recent.appendleft(entry)
                fills[fill["person"], coin] = entry
        for person, slot, side, _ in pending:
            coin = old_ids[slot]
            filled = fills.get((person, coin))
            self.receipts[person].appendleft(
                {
                    "batch_id": batch,
                    "ticker": self.labels[coin][1],
                    "kind": "order",
                    "side": "buy" if side == BUY else "sell",
                    "price": filled["price"] if filled else None,
                    "fee": filled["fee"] if filled else 0,
                    "quantity": filled["quantity"] if filled else 0,
                }
            )
        if deployer is not None and self.pending_launch is not None:
            name, ticker = self.pending_launch
            launched = result["launched_slots"]
            if launched:
                coin_id = int(market.state.coin_id[0, launched[0]])
                self.labels[coin_id] = (name, ticker)
            self.receipts[deployer].appendleft(
                {"batch_id": batch, "ticker": ticker, "kind": "launch", "opened": bool(launched)}
            )
        self.pending_launch = None
        self.terms = market.begin_batch()
        self.closes_at = time() + self.interval

    def check_launch(self, person: int, ticker: str):
        if self.pending_launch:
            raise HTTPException(409, "Another launch is already queued for this batch.")
        if any(label[1] == ticker for label in self.labels.values()):
            raise HTTPException(409, "This ticker has already been used.")
        if self.market.balances(person)["cash"] < self.launch_fee:
            raise HTTPException(409, "Available paper balance is below the launch fee.")

    def launch(self, person: int, name: str, ticker: str):
        self.check_launch(person, ticker)
        self.market.request_launch(person)
        self.pending_launch = (name, ticker)

    @property
    def launch_fee(self):
        return int(self.market.lever_values[0, 0])

    def check_batch(self, batch: int):
        if batch != self.market.state.t or time() >= self.closes_at:
            raise HTTPException(409, "This batch closed. Review the new terms and submit again.")

    def check_order(self, person: int, body: LimitOrder):
        self.check_batch(body.batch_id)
        coin = next((c for c in self.terms["coins"] if c["coin_id"] == body.coin_id), None)
        if coin is None:
            raise HTTPException(409, "This coin has left the market.")
        slot = coin["slot"]
        if any(p == person and c == slot for p, c, _, _ in self.market.pending):
            raise HTTPException(409, "You already submitted an order for this coin and batch.")
        return slot

    def order(self, person: int, body: LimitOrder):
        slot = self.check_order(person, body)
        self.market.submit(person, slot, body.side, [(body.limit_price, body.quantity)])

    def snapshot(self, person: int | None):
        market = self.market
        state = market.snapshot()
        terms = {c["slot"]: c for c in self.terms["coins"]}
        coins = []
        for coin in state["coins"]:
            slot = coin["slot"]
            name, ticker = self.labels[coin["coin_id"]]
            coins.append(
                {
                    **coin,
                    **{k: v for k, v in terms[slot].items() if k not in ("stage", "last_price")},
                    "name": name,
                    "ticker": ticker,
                    "holders": int((market.state.hold[0, slot] > 0).sum()),
                }
            )
        account = None
        if person is not None:
            balance = market.balances(person)
            account = {
                "cash": balance["cash"],
                "positions": {
                    c["coin_id"]: balance["tokens_by_slot"][c["slot"]]
                    for c in coins
                    if c["slot"] in balance["tokens_by_slot"]
                },
                "receipts": list(self.receipts[person]),
                "pending_coins": [int(market.state.coin_id[0, c]) for p, c, _, _ in market.pending if p == person],
                "pending_launch": self.pending_launch[1]
                if self.pending_launch and market.launch_by == person
                else None,
            }
        return {
            "batch_id": state["batch_id"],
            "closes_at": self.closes_at,
            "coins": coins,
            "account": account,
            "trades": list(self.recent),
            "commitment": self.terms["quoter_commitment"],
            "launch_fee": self.launch_fee,
            "base_fee_bps": market.cfg.base_fee_bps,
            "epoch_batches": market.cfg.epoch,
            "supply": SUPPLY,
        }


def create_app(interval: float | None = None, *, sandbox: bool = False, gate: Gate | None = None):
    gate = gate or Gate(os.environ.get("LM_ATTESTATION_URL", "http://127.0.0.1:8787"))
    if interval is None:
        interval = BATCH_SECONDS if sandbox else 60

    @asynccontextmanager
    async def lifespan(app):
        policy = load_policy(os.environ["LM_QUOTER"]) if os.environ.get("LM_QUOTER") else None
        room = app.state.room = PaperRoom(interval, policy)

        async def clock():
            while True:
                await asyncio.sleep(max(0, room.closes_at - time()))
                room.advance()

        async with asyncio.TaskGroup() as group:
            task = group.create_task(clock())
            try:
                yield
            finally:
                task.cancel()

    app = FastAPI(title="Learned Markets paper trading", lifespan=lifespan)

    async def account_key(request):
        if sandbox:
            return request.cookies.get(COOKIE)
        return await gate.identity(request.cookies.get("lm_session"))

    def snapshot_for(room, key):
        return {**room.snapshot(room.sessions.get(key)), "access": "sandbox" if sandbox else "solana"}

    @app.get("/api/market")
    async def snapshot(request: Request, response: Response):
        room = app.state.room
        response.headers["Cache-Control"] = "private, no-store"
        key = None
        if sandbox or request.cookies.get("lm_session"):
            try:
                key = await account_key(request)
            except HTTPException as exc:
                if exc.status_code not in (401, 403):
                    raise
        return snapshot_for(room, key)

    @app.post("/api/session")
    async def session(request: Request, response: Response):
        room = app.state.room
        key = await account_key(request)
        if key not in room.sessions:
            person = len(room.sessions) + 1
            if person >= room.market.cfg.n_people:
                raise HTTPException(503, "All paper accounts in this room are in use.")
            if sandbox:
                key = secrets.token_urlsafe(32)
                response.set_cookie(COOKIE, key, httponly=True, samesite="strict", path="/api")
            room.market.credit(person, STARTING_CASH)
            room.sessions[key] = person
        return snapshot_for(room, key)

    async def action(body, request, *, prepare=False):
        room = app.state.room
        key = await account_key(request)
        person = room.sessions.get(key)
        if person is None:
            raise HTTPException(401, "Open a market account to continue.")
        room.check_batch(body.batch_id)
        is_order = isinstance(body, LimitOrder)
        if is_order:
            room.check_order(person, body)
        else:
            room.check_launch(person, body.ticker)
        if not sandbox:
            spec, contents = (trade_intent if is_order else nomination_intent)(room.room_id, body)
            cookie = request.cookies.get("lm_session")
            if prepare:
                return await gate.call(cookie, "/v1/intents/prepare", spec)
            if not body.intent:
                raise HTTPException(403, "A confirmed wallet-signed intent is required.")
            # The attestation service atomically admits an intent once, after checking
            # the current registry, badge, binding, signer, payload and chain deadline.
            receipt = await gate.call(
                cookie,
                "/v1/intents/admit",
                {
                    "intent": body.intent,
                    "contentsHex": contents,
                    "expectedTarget": spec["target"],
                    "expectedKind": spec["kind"],
                },
            )
            if (
                receipt.get("admitted") is not True
                or receipt.get("target") != spec["target"]
                or receipt.get("intent") != body.intent
                or receipt.get("kind") != (0 if is_order else 1)
            ):
                raise HTTPException(409, "On-chain admission does not match this action.")
            room.check_batch(body.batch_id)
        elif prepare:
            raise HTTPException(409, "Sandbox actions do not submit transactions.")
        # Recheck after RPC awaits and apply without yielding to another handler or clock.
        if is_order:
            room.order(person, body)
        else:
            room.launch(person, body.name, body.ticker)
        return snapshot_for(room, key)

    @app.post("/api/orders/prepare")
    async def prepare_order(body: LimitOrder, request: Request):
        return await action(body, request, prepare=True)

    @app.post("/api/launches/prepare")
    async def prepare_launch(body: Launch, request: Request):
        return await action(body, request, prepare=True)

    @app.post("/api/orders")
    async def order(body: LimitOrder, request: Request):
        return await action(body, request)

    @app.post("/api/launches")
    async def launch(body: Launch, request: Request):
        return await action(body, request)

    return app


app = create_app(sandbox=os.environ.get("LM_PAPER_SANDBOX") == "1")
