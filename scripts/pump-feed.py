"""Mirror pump.fun launch *names* in real time; trading behaviour stays ours (the sim crowd).

Subscribes to the pump program's logs on Solana mainnet, decodes each Anchor CreateEvent
(name, symbol, metadata URI), resolves the image, and keeps the newest tokens in a small
JSON ring file the population runner reads. Set PUMP_WS to use a private RPC websocket.

    .venv/bin/python scripts/pump-feed.py [--out .pump-feed.json] [--keep 300]
"""

import argparse
import asyncio
import base64
import hashlib
import json
import struct
import os
import re
import time

import httpx
import websockets

FEED = os.environ.get("PUMP_WS", "wss://api.mainnet-beta.solana.com")
PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
CREATE = hashlib.sha256(b"event:CreateEvent").digest()[:8]


def create_events(logs: list[str]):
    """Yield {name, symbol, uri, mint} for each CreateEvent in a transaction's logs."""
    for line in logs:
        if not line.startswith("Program data: "):
            continue
        try:
            data = base64.b64decode(line[14:])
        except ValueError:
            continue
        if data[:8] != CREATE:
            continue
        off, out = 8, []
        try:
            for _ in range(3):
                (n,) = struct.unpack_from("<I", data, off)
                out.append(data[off + 4 : off + 4 + n].decode("utf-8", "replace"))
                off += 4 + n
            mint = base64.b16encode(data[off : off + 32]).decode()
        except struct.error:
            continue
        yield {"name": out[0], "symbol": out[1], "uri": out[2], "mint": mint}


def clean(token: dict) -> dict | None:
    name = re.sub(r"\s+", " ", str(token.get("name") or "")).strip()[:32].strip()
    ticker = re.sub(r"[^A-Z0-9]", "", str(token.get("symbol") or "").upper())[:6]
    if len(name) < 2 or len(ticker) < 2 or not re.match(r"^\S(?:.*\S)?$", name):
        return None
    return {"name": name, "ticker": ticker, "uri": token.get("uri"), "mint": token.get("mint"), "seen": time.time()}


async def resolve_image(http: httpx.AsyncClient, uri: str | None) -> str | None:
    if not uri or not uri.startswith("https://"):
        return None
    try:
        meta = (await http.get(uri, timeout=4)).json()
    except Exception:
        return None
    image = meta.get("image")
    return image if isinstance(image, str) and image.startswith("https://") and len(image) <= 200 else None


def write(path: str, items: list[dict]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(items, fh)
    os.replace(tmp, path)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=".pump-feed.json")
    ap.add_argument("--keep", type=int, default=300)
    args = ap.parse_args()
    items: list[dict] = []
    async with httpx.AsyncClient(follow_redirects=True) as http:
        while True:
            try:
                async with websockets.connect(FEED, ping_interval=20, max_size=2**22) as ws:
                    sub = {"jsonrpc": "2.0", "id": 1, "method": "logsSubscribe",
                           "params": [{"mentions": [PUMP]}, {"commitment": "confirmed"}]}  # fmt: skip
                    await ws.send(json.dumps(sub))
                    print(json.dumps({"event": "connected", "feed": FEED}), flush=True)
                    async for raw in ws:
                        msg = json.loads(raw)
                        value = msg.get("params", {}).get("result", {}).get("value", {})
                        if value.get("err") is not None:
                            continue
                        for event in create_events(value.get("logs") or []):
                            token = clean(event)
                            if not token:
                                continue
                            token["image"] = await resolve_image(http, token.pop("uri"))
                            items = [token, *[t for t in items if t["ticker"] != token["ticker"]]][: args.keep]
                            write(args.out, items)
                            print(json.dumps({"event": "pump-launch", "name": token["name"], "ticker": token["ticker"]}), flush=True)
            except Exception as exc:  # reconnect on any drop
                print(json.dumps({"event": "reconnect", "error": str(exc)[:200]}), flush=True)
                await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(main())
