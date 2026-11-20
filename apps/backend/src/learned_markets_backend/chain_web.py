"""Confirmed market and wallet reads for the validator-backed web client."""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager, suppress

import httpx
import torch
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey

from .chain import PROGRAM_ID, ledger_balance_address, ledger_market_address, ledger_position_address
from .charting import market_candles
from .generated.accounts.config import Config
from .generated.accounts.ledgerBalance import LedgerBalance
from .generated.accounts.ledgerMarket import LedgerMarket
from .generated.accounts.ledgerPosition import LedgerPosition
from .generated.accounts.walletBinding import WalletBinding
from .generated.instructions.registerParticipant import find_WalletBinding
from .live_lifecycle import PROFILE, STAGES
from .validator_market import WINDOW, ValidatorMarket
from .web_gate import Gate


@asynccontextmanager
async def lifespan(app):
    torch.set_num_threads(2)
    url = os.environ.get("LM_RPC_URL", "http://127.0.0.1:8899")
    async with AsyncClient(url, commitment="confirmed", timeout=8) as rpc, httpx.AsyncClient(timeout=8) as http:
        app.state.rpc = rpc
        network = os.environ.get("LM_NETWORK", "surfpool")
        if network == "surfpool":
            response = await http.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "getVersion"})
            response.raise_for_status()
            if not response.json().get("result", {}).get("surfnet-version"):
                raise RuntimeError("Expected the Surfpool RPC")
        elif (
            network != "devnet"
            or str((await rpc.get_genesis_hash()).value) != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
        ):
            raise RuntimeError("Unexpected Solana network")
        app.state.network = network
        engine = app.state.engine = ValidatorMarket(rpc, os.environ.get("DB_PATH", f"attestation-{network}.sqlite"))

        async def run():
            while True:
                try:
                    await engine.advance()
                except Exception:
                    logging.getLogger(__name__).exception("Validator settlement worker")
                await asyncio.sleep(float(os.environ.get("LM_SETTLE_POLL", "2")))

        worker = asyncio.create_task(run()) if network == "surfpool" else None
        try:
            yield
        finally:
            if worker:
                worker.cancel()
                with suppress(asyncio.CancelledError):
                    await worker
            engine.db.close()


app = FastAPI(title="Learned Markets on-chain", lifespan=lifespan)


@app.get("/api/chain")
async def market_board(wallet: str | None = None, market: str | None = None):
    try:
        owner = Pubkey.from_string(wallet) if wallet else None
        if market:
            Pubkey.from_string(market)
    except ValueError as exc:
        raise HTTPException(422, "Invalid Solana wallet") from exc
    rpc = app.state.rpc
    db = app.state.engine.db
    rows = db.execute("SELECT address,name,ticker,image FROM web_markets ORDER BY rowid DESC").fetchall()
    config, _ = Pubkey.find_program_address([b"config"], PROGRAM_ID)
    keys = [config]
    if owner:
        keys += [owner, find_WalletBinding(owner)[0]]
    keys.extend(Pubkey.from_string(row["address"]) for row in rows)

    # One confirmed RPC read covers the board and wallet on typical markets.
    async def read_accounts(addresses):
        responses = await asyncio.gather(
            *(
                rpc.get_multiple_accounts(addresses[i : i + 100], commitment="confirmed")
                for i in range(0, len(addresses), 100)
            )
        )
        return dict(zip(addresses, [a for response in responses for a in response.value], strict=True)), min(
            r.context.slot for r in responses
        )

    values, slot = await read_accounts(keys)

    def decode(raw, cls):
        return cls.decode(raw.data) if raw and raw.owner == PROGRAM_ID and not raw.executable else None

    gate = decode(values[config], Config)
    board = app.state.engine.lifecycle.snapshot() or {"coins": []}
    lives = {c["address"]: c for c in board["coins"]}
    markets = []
    for row in rows:
        key = Pubkey.from_string(row["address"])
        value = decode(values[key], LedgerMarket)
        if value and ledger_market_address(value.marketId)[0] == key:
            markets.append(
                {
                    **dict(row),
                    "kind": "ledger",
                    "price": str(value.lastPrice),
                    "stage": STAGES.get(lives.get(str(key), {}).get("stage"), "Line")
                    if value.live
                    else lives.get(str(key), {}).get("ended_reason", "Closed"),
                    "live": value.live,
                    "survival": lives.get(str(key), {}).get("timer"),
                    "activity": lives.get(str(key), {}).get("activity", 0),
                    "heat": lives.get(str(key), {}).get("heat", 0),
                    "reserve_cash": str(value.reserveCash),
                    "reserve_tokens": str(value.reserveTokens),
                }
            )
    fills = []
    for record in db.execute(
        """SELECT intent,market,batch,details,signature FROM web_orders WHERE status='filled'
        AND signature IS NOT NULL AND (? IS NULL OR market=?) ORDER BY batch DESC,rowid DESC LIMIT 240""",
        (market, market),
    ):
        detail = json.loads(record["details"])
        fills.append(
            {
                "intent": record["intent"],
                "market": record["market"],
                "batch": record["batch"],
                "side": detail["side"],
                "participant": detail["participant"],
                "signature": record["signature"],
                "quantity": detail["quantity"],
                "price": detail.get("clearing_price"),
            }
        )
    # Per-batch buy and sell totals let the board show how much of each side cancelled.
    live_set = {m["address"] for m in markets if m["live"]}
    rounds = [
        {
            "market": r["market"],
            "batch": r["batch"],
            "buys": str(r["buys"]),
            "sells": str(r["sells"]),
            "matched": str(min(r["buys"], r["sells"])),
            "maker_side": "sell" if r["buys"] > r["sells"] else "buy" if r["sells"] > r["buys"] else None,
            "maker_qty": str(abs(r["buys"] - r["sells"])),
            "price": r["price"],
        }
        for r in db.execute(
            """SELECT * FROM (SELECT market,batch,buys,sells,price,
                ROW_NUMBER() OVER (PARTITION BY market ORDER BY batch DESC) AS n FROM (
                SELECT market,batch,
                SUM(CASE WHEN json_extract(details,'$.side')='buy' THEN CAST(json_extract(details,'$.quantity') AS INTEGER) ELSE 0 END) AS buys,
                SUM(CASE WHEN json_extract(details,'$.side')='sell' THEN CAST(json_extract(details,'$.quantity') AS INTEGER) ELSE 0 END) AS sells,
                MAX(json_extract(details,'$.clearing_price')) AS price
                FROM web_orders WHERE status='filled' AND (? IS NULL OR market=?) GROUP BY market,batch))
            WHERE n<=60 ORDER BY batch DESC""",
            (market, market),
        )
        if r["market"] in live_set or r["market"] == market
    ]
    # Liquidity paid out when coins closed, newest first. Lamport amounts are strings.
    flows = [
        {
            "batch": r["batch"],
            "market": r["market"],
            "ticker": r["ticker"],
            "total": str(r["total"]),
            "survivors": [{**s, "amount": str(s["amount"])} for s in json.loads(r["survivors"])],
            "deployers_amount": str(r["deployers_amount"]),
            "platform_amount": str(r["platform_amount"]),
            "signature": r["signature"],
            "ts": r["ts"],
        }
        for r in db.execute(
            "SELECT * FROM web_flows ORDER BY ts DESC,rowid DESC LIMIT 40"
        )
    ]
    account = None
    if owner:
        binding = decode(values[find_WalletBinding(owner)[0]], WalletBinding)
        account = {
            "wallet": str(owner),
            "lamports": str(values[owner].lamports if values[owner] else 0),
            "participant": str(binding.participant) if binding and binding.active and binding.wallet == owner else None,
        }
        if account["participant"]:
            participant = binding.participant
            balance_key = ledger_balance_address(participant)
            positions = {
                m["address"]: ledger_position_address(Pubkey.from_string(m["address"]), participant) for m in markets
            }
            accounts, _ = await read_accounts([balance_key, *positions.values()])
            balance = decode(accounts[balance_key], LedgerBalance)
            account["cash"] = str(balance.cash) if balance else None
            account["positions"] = {
                addr: str(pos.tokens)
                for addr, key in positions.items()
                if (pos := decode(accounts[key], LedgerPosition))
            }
            account["orders"] = [
                dict(row)
                for row in db.execute(
                    """SELECT w.* FROM web_orders w
                JOIN admitted_intents a USING(intent) WHERE a.participant=? ORDER BY a.admitted_at DESC LIMIT 16""",
                    (str(participant),),
                )
            ]
    return {
        "network": app.state.network,
        "slot": slot,
        "program": str(PROGRAM_ID),
        "gate_ready": gate is not None,
        "markets": markets,
        "fills": fills,
        "rounds": rounds,
        "flows": flows,
        "candles": market_candles(db, market) if market else [],
        "batch_slots": WINDOW,
        "lifecycle_profile": PROFILE,
        "account": account,
    }


class LaunchCoin(BaseModel):
    name: str = Field(min_length=2, max_length=32, pattern=r"^\S(?:.*\S)?$")
    ticker: str = Field(pattern=r"^[A-Z0-9]{2,6}$")
    image: str | None = Field(default=None, max_length=200, pattern=r"^(/memes/[A-Za-z0-9_-]+\.svg|https://\S+)$")


@app.post("/api/chain/launch")
async def launch_coin(body: LaunchCoin, request: Request):
    if app.state.network != "surfpool":
        raise HTTPException(409, "Market creation is enabled on Surfpool.")
    gate = Gate(os.environ.get("LM_ATTESTATION_URL", "http://127.0.0.1:8787"))
    identity = await gate.call(request.cookies.get("lm_session"), "/v1/me")
    if not identity.get("eligible"):
        raise HTTPException(403, "Verify your participant badge.")
    return await app.state.engine.launch(identity, body.name, body.ticker, body.image)
