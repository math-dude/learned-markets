import unittest

from fastapi.testclient import TestClient
from learned_markets_backend.clearing import clear
from learned_markets_backend.contracts import ClearRequest, Observation
from learned_markets_backend.service import create_app
from learned_markets_core.units import prices
from pydantic import ValidationError


def observation():
    return {
        "market": {
            "tick": 1029,
            "stage": "Rookie",
            "reserve_cash": "50000000",
            "reserve_tokens": "1000000000",
            "timer": 600.0,
            "batch_id": "1",
        },
        "previous_imbalance": 0.0,
    }


def people():
    return [
        {"participant": "alice", "cash": "1000000000", "tokens": "0"},
        {"participant": "bob", "cash": "1000000000", "tokens": "0"},
    ]


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app())

    def test_quote_is_sealed_and_integer_safe(self):
        obs = observation()
        quote = self.client.post("/quote", json=obs)
        self.assertEqual(quote.status_code, 200, quote.text)
        self.assertEqual(len(quote.json()["bid"]), 16)
        self.assertIsInstance(quote.json()["ask"][0], str)
        self.assertEqual(
            self.client.post("/quote", json={**obs, "user_curves": []}).status_code, 422
        )
        for amount in [True, 1.2, "1e5", "1000000000000000000000"]:
            obs["market"]["reserve_cash"] = amount
            with self.assertRaises(ValidationError):
                Observation.model_validate(obs)

    def test_core_ledger_and_caps_match_http(self):
        obs = observation()
        quote = self.client.post("/quote", json=obs).json()
        orders = [
            {
                "intent": who,
                "participant": who,
                "side": "buy",
                "curve": [{"price": str(int(prices()[1044])), "quantity": "30000000"}],
            }
            for who in ("alice", "bob")
        ]
        req = {
            "market": obs["market"],
            "quote": quote,
            "people": people(),
            "user_curves": orders,
        }
        result = self.client.post("/clear", json=req)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json(), clear(ClearRequest.model_validate(req)))
        result = result.json()
        self.assertGreater(len(result["fills"]), 0)
        after = result["after"]
        total = (
            sum(int(p["cash"]) for p in after["people"])
            + int(after["reserve_cash"])
            + int(after["platform_cash_delta"])
        )
        self.assertEqual(total, 2_050_000_000)
        self.assertEqual(
            sum(int(p["tokens"]) for p in after["people"])
            + int(after["reserve_tokens"]),
            1_000_000_000,
        )
        self.assertTrue(all(int(p["tokens"]) <= 20_000_000 for p in after["people"]))
        duplicate = {
            **req,
            "user_curves": [orders[0], {**orders[0], "intent": "other"}],
        }
        self.assertEqual(self.client.post("/clear", json=duplicate).status_code, 422)

    def test_empty_batch(self):
        obs = observation()
        quote = self.client.post("/quote", json=obs).json()
        req = {
            "market": obs["market"],
            "quote": quote,
            "people": people(),
            "user_curves": [],
        }
        response = self.client.post("/clear", json=req)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["fills"], [])


if __name__ == "__main__":
    unittest.main()
