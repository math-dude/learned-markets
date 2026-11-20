"""HTTP surface of the auctioneer.

    uv run --all-packages uvicorn learned_markets_backend.api:app

Set LM_QUOTER to an exported `quoter.pt` to run the trained quoter; otherwise
the rule-based quoter runs. A batch is cleared by POST /batch/clear, so a clock
(see clock.py) or a test can drive time.
"""

from __future__ import annotations

import os
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException
from learned_markets_core.units import SUPPLY
from pydantic import BaseModel, Field, model_validator

from .auctioneer import Auctioneer
from .contracts import MAX_LEDGER
from .quoter_net import load_policy

app = FastAPI(title="Learned Markets auctioneer")
_policy = load_policy(os.environ["LM_QUOTER"]) if os.environ.get("LM_QUOTER") else None
auctioneer = Auctioneer(policy=_policy)
_terms = auctioneer.begin_batch()


PersonId = Annotated[int, Field(ge=0, lt=auctioneer.cfg.n_people)]
Slot = Annotated[int, Field(strict=True, ge=0, lt=auctioneer.cfg.n_slots)]
Quantity = Annotated[int, Field(strict=True, ge=0, le=SUPPLY)]
Price = Annotated[int, Field(strict=True, gt=0, le=2**63 - 1)]


class OrderIn(BaseModel):
    person: PersonId
    slot: Slot
    side: Literal["buy", "sell"]
    points: list[tuple[Price, Quantity]] = Field(min_length=1, max_length=16)

    @model_validator(mode="after")
    def canonical(self):
        if not any(q for _, q in self.points):
            raise ValueError("at least one quantity must be positive")
        for (p0, q0), (p1, q1) in zip(self.points, self.points[1:]):
            if p1 <= p0 or (q1 > q0 if self.side == "buy" else q1 < q0):
                raise ValueError("noncanonical curve")
        return self


class CreditIn(BaseModel):
    person: PersonId
    lamports: int = Field(strict=True, gt=0, le=MAX_LEDGER)


@app.get("/state")
async def state() -> dict:
    return auctioneer.snapshot()


@app.get("/terms")
async def terms() -> dict:
    """Terms and the quoter's commitment for the batch now collecting orders."""
    return _terms


@app.get("/balances/{person}")
async def balances(person: PersonId) -> dict:
    return auctioneer.balances(person)


@app.post("/credit")
async def credit(body: CreditIn) -> dict:
    if auctioneer.balances(body.person)["cash"] + body.lamports > MAX_LEDGER:
        raise HTTPException(422, "balance exceeds the supported ledger range")
    auctioneer.credit(body.person, body.lamports)
    return auctioneer.balances(body.person)


@app.post("/launch/{deployer}")
async def launch(deployer: PersonId) -> dict:
    if auctioneer.launch_by is not None:
        raise HTTPException(409, "a launch is already queued")
    auctioneer.request_launch(deployer)
    return {"queued": True}


@app.post("/orders")
async def orders(body: OrderIn) -> dict:
    if int(auctioneer.state.stage[0, body.slot]) == 0:
        raise HTTPException(409, "slot has no active coin")
    if any(p == body.person and c == body.slot for p, c, _, _ in auctioneer.pending):
        raise HTTPException(409, "a curve is already queued for this person and coin")
    auctioneer.submit(body.person, body.slot, body.side, body.points)
    return {"queued": True, "batch_id": _terms["batch_id"]}


@app.post("/batch/clear")
async def clear() -> dict:
    global _terms
    result = auctioneer.clear()
    _terms = auctioneer.begin_batch()
    return result
