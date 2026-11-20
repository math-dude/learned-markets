"""Operator-only initial trading credit for an active Surfpool participant."""

import argparse
import asyncio
import os
from pathlib import Path

import httpx
from learned_markets_backend.chain import ledger_balance_address
from learned_markets_backend.generated.accounts.config import Config
from learned_markets_backend.generated.accounts.ledgerBalance import LedgerBalance
from learned_markets_backend.generated.accounts.participant import Participant
from learned_markets_backend.generated.accounts.walletBinding import WalletBinding
from learned_markets_backend.generated.instructions.creditLedgerBalance import CreditLedgerBalance
from learned_markets_backend.generated.instructions.registerParticipant import find_WalletBinding
from learned_markets_backend.validator_market import CONFIG
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import ID as SYSTEM
from solders.transaction import Transaction


async def main(wallet, refill=False):
    url = os.environ.get("LM_RPC_URL", "http://127.0.0.1:8899")
    async with httpx.AsyncClient(timeout=6) as http:
        version = (await http.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "getVersion"})).json()
        if not version.get("result", {}).get("surfnet-version"):
            raise RuntimeError("Expected Surfpool")
    async with AsyncClient(url, commitment="confirmed") as rpc:
        cfg = await Config.fetch(rpc, CONFIG)
        admin = Keypair.from_json((Path(os.environ.get("LM_KEYS_DIR", "keys")) / "admin.json").read_text())
        if not cfg or cfg.network != "surfpool" or cfg.admin != admin.pubkey():
            raise RuntimeError("Unexpected gate or authority")
        binding = await WalletBinding.fetch(rpc, find_WalletBinding(wallet)[0])
        if not binding or not binding.active or binding.wallet != wallet:
            raise RuntimeError("Wallet not registered")
        participant = await Participant.fetch(rpc, binding.participant)
        if participant.currentWallet != wallet or participant.status.to_json()["kind"] != "Active":
            raise RuntimeError("Inactive participant")
        balance = ledger_balance_address(binding.participant)
        existing = await LedgerBalance.fetch(rpc, balance)
        if existing and not refill:
            raise SystemExit("Trading balance already exists.")
        amount = 2_000_000_000 - (existing.cash if existing else 0)
        if amount <= 0:
            print("Test balance already funded.")
            return
        ix = CreditLedgerBalance(
            {"amount": amount},
            {
                "admin": admin.pubkey(),
                "config": CONFIG,
                "participant": binding.participant,
                "balance": balance,
                "systemProgram": SYSTEM,
            },
        )
        block = (await rpc.get_latest_blockhash()).value
        tx = Transaction.new_signed_with_payer([ix], admin.pubkey(), [admin], block.blockhash)
        print("Submitting", tx.signatures[0], flush=True)
        await rpc.send_transaction(
            tx,
            TxOpts(
                skip_confirmation=False,
                preflight_commitment="confirmed",
                last_valid_block_height=block.last_valid_block_height,
            ),
        )
        print("Confirmed validator trading balance", (await LedgerBalance.fetch(rpc, balance)).cash)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wallet", type=Pubkey.from_string)
    parser.add_argument("--refill", action="store_true", help="Restore this test balance to 2 ledger SOL")
    args = parser.parse_args()
    asyncio.run(main(args.wallet, args.refill))
