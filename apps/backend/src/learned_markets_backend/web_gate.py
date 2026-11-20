"""Bind a signed Solana intent to one paper room, batch and action."""

import hashlib
import json
import struct

import httpx
from fastapi import HTTPException
from solders.pubkey import Pubkey


class Gate:
    def __init__(self, url: str):
        self.url = url.rstrip("/")

    async def call(self, cookie: str | None, path: str, body: dict | None = None) -> dict:
        if not cookie:
            raise HTTPException(401, "Sign in with an attested Solana wallet.")
        try:
            async with httpx.AsyncClient(base_url=self.url, cookies={"lm_session": cookie}, timeout=8) as client:
                res = await (client.get(path) if body is None else client.post(path, json=body))
                data = res.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, "The Solana attestation service is unavailable.") from exc
        if not res.is_success:
            raise HTTPException(res.status_code, data.get("message", "Wallet gate denied the request."))
        return data

    async def identity(self, cookie: str | None) -> str:
        data = await self.call(cookie, "/v1/me")
        if (
            data.get("eligible") is not True
            or not isinstance(data.get("participant"), dict)
            or not data["participant"].get("address")
        ):
            raise HTTPException(403, "An active wallet binding and Solana attestation are required.")
        return data["participant"]["address"]


def target(room_id: str, batch: int, *fields) -> Pubkey:
    # A paper target is never used as a ledger-market PDA. The domain and room
    # instance keep approvals from another market run or batch unusable here.
    payload = json.dumps(
        ["learned-markets/paper/v1", room_id, batch, *fields], separators=(",", ":"), ensure_ascii=False
    )
    return Pubkey.from_bytes(hashlib.sha256(payload.encode()).digest())


def trade_intent(room_id, body):
    address = target(room_id, body.batch_id, "trade", body.coin_id)
    contents = bytes([1, int(body.side == "sell"), 1]) + struct.pack("<QQ", body.limit_price, body.quantity)
    return (
        {
            "kind": "trade",
            "target": str(address),
            "trade": {"side": body.side, "points": [{"price": str(body.limit_price), "quantity": str(body.quantity)}]},
        },
        contents.hex(),
    )


def nomination_intent(room_id, body):
    candidate = target(room_id, body.batch_id, "launch", body.name, body.ticker)
    return (
        {"kind": "nomination", "target": str(candidate), "nomination": {"candidate": str(candidate)}},
        (bytes([1]) + bytes(candidate)).hex(),
    )
