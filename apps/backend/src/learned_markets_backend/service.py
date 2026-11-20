"""Sealed quoter service. Only /clear accepts order information."""

from __future__ import annotations

import os
from importlib import import_module

from fastapi import FastAPI, HTTPException

from .clearing import clear
from .contracts import ClearRequest, Observation, Quote
from .policy import Policy, rule_quote


def create_app(policy: Policy = rule_quote, rpc_url: str | None = None) -> FastAPI:
    app = FastAPI(title="Learned Markets quoter")

    @app.post("/quote")
    def quote(obs: Observation):
        try:
            decision = Quote.model_validate(policy(obs).model_dump())
            return decision.model_dump(mode="json")
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    @app.post("/clear")
    def clear_batch(request: ClearRequest):
        try:
            return clear(request)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    @app.get("/v1/ledger/markets/{address}")
    async def market_state(address: str):
        from solana.rpc.async_api import AsyncClient
        from solders.pubkey import Pubkey

        from .chain import read_market

        if not rpc_url:
            raise HTTPException(503, "LM_RPC_URL is required for chain reads")
        try:
            key = Pubkey.from_string(address)
        except ValueError as error:
            raise HTTPException(422, "invalid market address") from error
        try:
            async with AsyncClient(rpc_url) as rpc:
                return await read_market(rpc, key)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    return app


def configured_app() -> FastAPI:
    factory = os.environ.get("LM_QUOTER_POLICY_FACTORY")
    if factory:
        module, separator, attribute = factory.partition(":")
        if not separator or not module or not attribute:
            raise ValueError("LM_QUOTER_POLICY_FACTORY must be module:function")
        return create_app(
            getattr(import_module(module), attribute)(), os.environ.get("LM_RPC_URL")
        )
    return create_app(rpc_url=os.environ.get("LM_RPC_URL"))


app = configured_app()
