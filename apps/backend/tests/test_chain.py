import base64
import json
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from learned_markets_backend.chain import PROGRAM_ID, read_market
from learned_markets_backend.generated.accounts.ledgerBalance import LedgerBalance
from learned_markets_backend.generated.accounts.ledgerMarket import LedgerMarket
from learned_markets_backend.generated.accounts.ledgerPlatform import LedgerPlatform
from learned_markets_backend.generated.accounts.ledgerPosition import LedgerPosition
from learned_markets_backend.generated.instructions.settleLedgerBatch import (
    SettleLedgerBatch,
)
from learned_markets_backend.generated.types.ledgerFill import LedgerFill
from solders.instruction import AccountMeta
from solders.pubkey import Pubkey
from solders.rpc.responses import GetAccountInfoResp

V = json.loads(
    (Path(__file__).resolve().parents[3] / "fixtures/ledger-wire.json").read_text()
)


class GeneratedWireTests(unittest.TestCase):
    def test_real_sbf_accounts(self):
        expected = V["after"]
        decoders = {
            "balance": LedgerBalance,
            "market": LedgerMarket,
            "platform": LedgerPlatform,
            "position": LedgerPosition,
        }
        accounts = {
            key: decoder.decode(base64.b64decode(V["accounts"][key]["dataBase64"]))
            for key, decoder in decoders.items()
        }
        self.assertEqual(accounts["market"].reserveCash, expected["reserve_cash"])
        self.assertEqual(accounts["market"].reserveTokens, expected["reserve_tokens"])
        self.assertEqual(accounts["platform"].cash, expected["platform_cash"])
        self.assertEqual(accounts["balance"].cash, expected["cash"][1])
        self.assertEqual(accounts["position"].tokens, expected["tokens"][1])

    def test_real_sbf_instruction(self):
        vector = V["settleLedgerBatch"]
        request = vector["request"]
        args = {
            **request,
            "market": Pubkey.from_string(request["market"]),
            "intents": [
                LedgerFill(
                    Pubkey.from_string(fill["intent"]),
                    bytes.fromhex(fill["contentsHex"]),
                    fill["quantity"],
                    fill["feeRatePpm"],
                )
                for fill in request["intents"]
            ],
        }
        names = [
            "settlementAuthority",
            "config",
            "market",
            "platform",
            "credential",
            "schema",
            "schemaMint",
        ]
        account_list = vector["accounts"]
        accounts = {
            name: Pubkey.from_string(value[0])
            for name, value in zip(names, account_list)
        }
        remaining = [
            AccountMeta(Pubkey.from_string(address), signer, writable)
            for address, writable, signer in account_list[7:]
        ]
        instruction = SettleLedgerBatch(args, accounts, remaining_accounts=remaining)
        self.assertEqual(bytes(instruction.data).hex(), vector["dataHex"])
        self.assertEqual(
            [[str(a.pubkey), a.is_writable, a.is_signer] for a in instruction.accounts],
            account_list,
        )

    def test_backend_builds_the_fixture_through_generated_bindings(self):
        import struct

        from learned_markets_backend.chain import TraderAccounts, settlement_instruction
        from learned_markets_backend.contracts import ClearRequest
        from test_quoter import observation

        vector = V["settleLedgerBatch"]
        wire = vector["request"]
        entry = wire["intents"][0]
        raw = bytes.fromhex(entry["contentsHex"])
        points = [
            {"price": str(p), "quantity": str(q)}
            for p, q in struct.iter_unpack("<QQ", raw[3:])
        ]
        participant = V["participant"]
        req = ClearRequest.model_validate(
            {
                "market": observation()["market"],
                "quote": {
                    "centre_tick": 1029,
                    "bid": ["0"] * 16,
                    "ask": ["1"] * 16,
                    "cap_share": 0.02,
                    "fee0": 0.0,
                    "half_life": 1.0,
                    "slope": 0.0,
                },
                "people": [{"participant": participant, "cash": "1000", "tokens": "0"}],
                "user_curves": [
                    {
                        "intent": entry["intent"],
                        "participant": participant,
                        "side": "buy",
                        "curve": points,
                    }
                ],
            }
        )
        accounts = [Pubkey.from_string(row[0]) for row in vector["accounts"]]
        result = {
            "batch_id": str(wire["batchId"]),
            "clearing_price": str(wire["clearingPrice"]),
            "quoter_buy": str(wire["quoterBuy"]),
            "quoter_sell": str(wire["quoterSell"]),
            "fills": [
                {
                    "intent": entry["intent"],
                    "participant": participant,
                    "side": "buy",
                    "quantity": str(entry["quantity"]),
                    "fee_rate_ppm": entry["feeRatePpm"],
                }
            ],
        }
        ix = settlement_instruction(
            req,
            result,
            accounts[2],
            accounts[0],
            accounts[1],
            accounts[4],
            accounts[5],
            accounts[6],
            {participant: TraderAccounts(*accounts[8:13])},
        )
        self.assertEqual(bytes(ix.data).hex(), vector["dataHex"])
        self.assertEqual(
            [[str(a.pubkey), a.is_writable, a.is_signer] for a in ix.accounts],
            vector["accounts"],
        )


class ReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_market_context_and_rejection(self):
        account = V["accounts"]["market"]
        address = Pubkey.from_string(account["address"])
        rpc = AsyncMock()

        def response(owner=PROGRAM_ID, data=None):
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "context": {"slot": 817},
                    "value": {
                        "owner": str(owner),
                        "executable": False,
                        "lamports": 1,
                        "rentEpoch": 0,
                        "data": [data or account["dataBase64"], "base64"],
                    },
                },
            }
            return GetAccountInfoResp.from_json(json.dumps(payload))

        rpc.get_account_info.return_value = response()
        result = await read_market(rpc, address)
        self.assertEqual(result["context_slot"], "817")
        self.assertEqual(result["reserve_cash"], str(V["after"]["reserve_cash"]))
        with self.assertRaisesRegex(ValueError, "PDA"):
            await read_market(rpc, Pubkey.new_unique())
        rpc.get_account_info.return_value = response(Pubkey.new_unique())
        with self.assertRaisesRegex(ValueError, "owner"):
            await read_market(rpc, address)
        raw = b"\x00" * 8 + base64.b64decode(account["dataBase64"])[8:]
        rpc.get_account_info.return_value = response(
            data=base64.b64encode(raw).decode()
        )
        with self.assertRaisesRegex(ValueError, "malformed"):
            await read_market(rpc, address)
