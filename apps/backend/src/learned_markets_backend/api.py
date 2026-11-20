"""HTTP surface of the auctioneer.

    uv run --all-packages uvicorn learned_markets_backend.api:app

Set LM_QUOTER to an exported `quoter.pt` to run the trained quoter; otherwise
the rule-based quoter runs. A batch is cleared by POST /batch/clear, so a clock
(see clock.py) or a test can drive time.
"""

from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .auctioneer import Auctioneer
from .quoter_net import load_policy

app = FastAPI(title="Learned Markets auctioneer")
_policy = load_policy(os.environ["LM_QUOTER"]) if os.environ.get("LM_QUOTER") else None
auctioneer = Auctioneer(policy=_policy)
_terms = auctioneer.begin_batch()


class OrderIn(BaseModel):
    person: int
    slot: int
    side: str  # "buy" or "sell"
    points: list[tuple[int, int]]  # (price in micro-lamports per token, cumulative tokens)


class CreditIn(BaseModel):
    person: int
    lamports: int


@app.get("/state")
def state() -> dict:
    return auctioneer.snapshot()


@app.get("/terms")
def terms() -> dict:
    """Terms and the quoter's commitment for the batch now collecting orders."""
    return _terms


@app.get("/balances/{person}")
def balances(person: int) -> dict:
    return auctioneer.balances(person)


@app.post("/credit")
def credit(body: CreditIn) -> dict:
    auctioneer.credit(body.person, body.lamports)
    return auctioneer.balances(body.person)


@app.post("/launch/{deployer}")
def launch(deployer: int) -> dict:
    auctioneer.request_launch(deployer)
    return {"queued": True}


@app.post("/orders")
def orders(body: OrderIn) -> dict:
    if body.side not in ("buy", "sell") or not 1 <= len(body.points) <= 16:
        raise HTTPException(422, "side must be buy or sell, with 1 to 16 curve points")
    auctioneer.submit(body.person, body.slot, body.side, body.points)
    return {"queued": True, "batch_id": _terms["batch_id"]}


@app.post("/batch/clear")
def clear() -> dict:
    global _terms
    result = auctioneer.clear()
    _terms = auctioneer.begin_batch()
    return result
