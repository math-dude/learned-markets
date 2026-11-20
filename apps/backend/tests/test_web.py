from fastapi.testclient import TestClient
from learned_markets_backend.web import STARTING_CASH, create_app


def test_sessions_batch_receipts_and_duplicate_orders():
    app = create_app(interval=600, sandbox=True)
    with TestClient(app) as client:
        assert client.get("/api/market").json()["account"] is None
        start = client.post("/api/session").json()
        assert client.post("/api/session").json()["account"]["cash"] == STARTING_CASH
        dog = next(c for c in start["coins"] if c["ticker"] == "DOG")
        order = {
            "batch_id": start["batch_id"],
            "coin_id": dog["coin_id"],
            "side": "buy",
            "quantity": 1_000_000,
            "limit_price": 1,
        }
        assert client.post("/api/orders", json={**order, "coin_id": 100}).status_code == 409
        assert client.post("/api/orders", json={**order, "quantity": -1}).status_code == 422
        assert client.post("/api/orders", json={**order, "person": 0}).status_code == 422
        assert client.post("/api/orders", json=order).status_code == 200
        assert client.post("/api/orders", json=order).status_code == 409
        client.portal.call(app.state.room.advance)
        assert client.post("/api/orders", json=order).status_code == 409
        me = client.get("/api/market").json()["account"]
        assert me["pending_coins"] == [] and me["cash"] == STARTING_CASH
        assert me["receipts"][0]["quantity"] == 0
        client.cookies.clear()
        assert client.post("/api/orders", json=order).status_code == 401
        other = client.post("/api/session").json()["account"]
        assert other["receipts"] == [] and other["positions"] == {}


def test_launch_metadata_follows_settlement_and_cannot_overwrite_request():
    app = create_app(interval=600, sandbox=True)
    with TestClient(app) as client:
        start = client.post("/api/session").json()
        launch = {"batch_id": start["batch_id"], "name": "River Cat", "ticker": "RIV"}
        assert client.post("/api/launches", json={**launch, "ticker": "DOG"}).status_code == 409
        queued = client.post("/api/launches", json=launch).json()
        assert queued["account"]["pending_launch"] == "RIV"
        assert all(c["ticker"] != "RIV" for c in queued["coins"])
        assert client.post("/api/launches", json={**launch, "ticker": "NEW"}).status_code == 409
        client.portal.call(app.state.room.advance)
        after = client.get("/api/market").json()
        assert after["account"]["cash"] == STARTING_CASH - after["launch_fee"]
        assert after["account"]["receipts"][0]["opened"]
        assert any(c["name"] == "River Cat" and c["stage"] == "line" for c in after["coins"])


def test_manual_api_validates_input_before_enqueuing(monkeypatch):
    from learned_markets_backend import api
    from learned_markets_backend.auctioneer import Auctioneer

    room = Auctioneer()
    monkeypatch.setattr(api, "auctioneer", room)
    monkeypatch.setattr(api, "_terms", room.begin_batch())
    with TestClient(api.app) as client:
        assert client.get("/balances/-1").status_code == 422
        assert client.post("/credit", json={"person": 0, "lamports": -1}).status_code == 422
        assert client.post("/credit", json={"person": 0, "lamports": STARTING_CASH}).status_code == 200
        assert client.post("/launch/0").status_code == 200
        assert client.post("/launch/1").status_code == 409
        client.post("/batch/clear").raise_for_status()
        order = {"person": 0, "slot": 0, "side": "buy", "points": [[50_000_000, 1_000]]}
        assert client.post("/orders", json={**order, "points": [[1, 1], [2, 2]]}).status_code == 422
        assert client.post("/orders", json={**order, "slot": -1}).status_code == 422
        assert client.post("/orders", json=order).status_code == 200
        assert client.post("/orders", json=order).status_code == 409
        client.post("/batch/clear").raise_for_status()


def test_solana_mode_requires_current_identity_and_matching_admission():
    from fastapi import HTTPException
    from learned_markets_backend.web import LimitOrder
    from learned_markets_backend.web_gate import trade_intent

    class TestGate:
        active = True
        mismatch = False

        async def identity(self, cookie):
            if not cookie or not self.active:
                raise HTTPException(403, "inactive")
            return "registered-participant"

        async def call(self, cookie, path, body):
            assert cookie == "registered-wallet-session"
            if path.endswith("prepare"):
                return {"intent": "A" * 44, "target": body["target"]}
            assert (
                body["contentsHex"]
                == (bytes([1, 0, 1]) + (60_000_000).to_bytes(8, "little") + (100_000).to_bytes(8, "little")).hex()
            )
            return {
                "admitted": True,
                "target": "other" if self.mismatch else body["expectedTarget"],
                "kind": 0,
                "intent": body["intent"],
            }

    gate = TestGate()
    app = create_app(interval=600, gate=gate)
    with TestClient(app) as client:
        assert client.get("/api/market").json()["access"] == "solana"
        assert client.post("/api/session").status_code == 403
        client.cookies.set("lm_session", "registered-wallet-session")
        start = client.post("/api/session").json()
        coin = start["coins"][0]
        body = {
            "coin_id": coin["coin_id"],
            "side": "buy",
            "quantity": 100_000,
            "limit_price": 60_000_000,
            "batch_id": start["batch_id"],
        }
        spec, _ = trade_intent(app.state.room.room_id, LimitOrder(**body))
        assert client.post("/api/orders", json=body).status_code == 403
        prepared = client.post("/api/orders/prepare", json=body).json()
        assert prepared["target"] == spec["target"]
        signed = {**body, "intent": prepared["intent"]}
        gate.mismatch = True
        assert client.post("/api/orders", json=signed).status_code == 409
        assert not app.state.room.market.pending
        gate.mismatch = False
        gate.active = False
        assert client.post("/api/orders", json=signed).status_code == 403
        assert not app.state.room.market.pending
        gate.active = True
        assert client.post("/api/orders", json=signed).json()["account"]["pending_coins"] == [coin["coin_id"]]
        client.portal.call(app.state.room.advance)
        assert client.get("/api/market").json()["account"]["positions"][str(coin["coin_id"])] == 100_000
