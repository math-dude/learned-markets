"""Wire contracts for Eren's shared market core.

Wide integers use decimal strings so browser callers preserve their values.
"""

from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    PlainSerializer,
    model_validator,
)

MAX_LEDGER = 9_000_000_000_000


def integer(value):
    if type(value) is int:
        return value
    if (
        isinstance(value, str)
        and value.isascii()
        and value.isdecimal()
        and len(value) <= 20
    ):
        return int(value)
    raise ValueError("expected a nonnegative integer or decimal string")


Amount = Annotated[
    int, BeforeValidator(integer), Field(ge=0, le=MAX_LEDGER), PlainSerializer(str)
]
Price = Annotated[
    int, BeforeValidator(integer), Field(gt=0, le=(1 << 63) - 1), PlainSerializer(str)
]
Tick = Annotated[int, Field(strict=True, ge=0, lt=2000)]
Finite = Annotated[float, Field(allow_inf_nan=False)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class PublicMarket(Contract):
    tick: Tick
    stage: Literal["Line", "Rookie", "Regular"]
    reserve_cash: Amount
    reserve_tokens: Amount = Field(le=1_000_000_000)
    timer: Finite = Field(ge=0)
    batch_id: Amount


class Observation(Contract):
    market: PublicMarket
    previous_imbalance: Finite = Field(ge=-1, le=1, default=0.0)


class Quote(Contract):
    centre_tick: Tick
    bid: list[Amount] = Field(min_length=16, max_length=16)
    ask: list[Amount] = Field(min_length=16, max_length=16)
    cap_share: Finite = Field(gt=0, le=0.02)
    fee0: Finite = Field(ge=0, le=0.2)
    half_life: Finite = Field(ge=1, le=720)
    slope: Finite = Field(ge=0, le=0.3)

    @model_validator(mode="after")
    def monotone(self):
        if any(a < b for a, b in zip(self.bid, self.bid[1:])):
            raise ValueError("maker bid must be non-increasing")
        if any(a > b for a, b in zip(self.ask, self.ask[1:])):
            raise ValueError("maker ask must be non-decreasing")
        if any(b and a for b, a in zip(self.bid, self.ask)):
            raise ValueError("maker bid and ask cross")
        return self


class Person(Contract):
    participant: str = Field(min_length=1)
    cash: Amount
    tokens: Amount = Field(le=20_000_000)
    buy_time: Finite = Field(ge=0, default=0.0)
    lock_fee: Finite = Field(ge=0, le=0.2, default=0.0)
    lock_half: Finite = Field(ge=1, le=720, default=1.0)


class CurvePoint(Contract):
    price: Price
    quantity: Amount


class Order(Contract):
    intent: str = Field(min_length=1)
    participant: str = Field(min_length=1)
    side: Literal["buy", "sell"]
    curve: list[CurvePoint] = Field(min_length=1, max_length=16)

    @model_validator(mode="after")
    def canonical(self):
        if not any(point.quantity for point in self.curve):
            raise ValueError("curve is empty")
        for a, b in zip(self.curve, self.curve[1:]):
            if a.price >= b.price or (
                a.quantity < b.quantity
                if self.side == "buy"
                else a.quantity > b.quantity
            ):
                raise ValueError("noncanonical curve")
        return self


class ClearRequest(Contract):
    market: PublicMarket
    quote: Quote
    people: list[Person] = Field(min_length=1, max_length=8)
    user_curves: list[Order] = Field(max_length=8)

    @model_validator(mode="after")
    def consistent(self):
        if self.quote.centre_tick != self.market.tick:
            raise ValueError("quote is for a different tick window")
        people = {person.participant for person in self.people}
        if len(people) != len(self.people):
            raise ValueError("duplicate participant snapshot")
        intents = {order.intent for order in self.user_curves}
        submitted = {order.participant for order in self.user_curves}
        if len(intents) != len(self.user_curves) or len(submitted) != len(
            self.user_curves
        ):
            raise ValueError("one intent per person per batch")
        if (
            self.market.reserve_tokens + sum(p.tokens for p in self.people)
            > 1_000_000_000
        ):
            raise ValueError("token snapshot exceeds supply")
        if not submitted <= people:
            raise ValueError("missing participant snapshot")
        return self
