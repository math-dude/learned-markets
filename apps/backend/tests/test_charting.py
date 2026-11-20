import json
import sqlite3

from learned_markets_backend.charting import market_candles


def test_confirmed_batch_volume_opening_and_market_isolation():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE web_orders(market,batch,status,signature,details)")
    for market, batch, status, signature, price, quantity in [
        ("a", 1, "filled", "sig", 100, 4),
        ("a", 1, "filled", "sig", 100, 6),
        ("a", 2, "filled", "sig2", 90, 3),
        ("b", 2, "filled", "sig3", 200, 100),
        ("a", 3, "confirming", None, 80, 4),
    ]:
        db.execute(
            "INSERT INTO web_orders VALUES(?,?,?,?,?)",
            (market, batch, status, signature, json.dumps(dict(clearing_price=str(price), quantity=str(quantity)))),
        )
    history = market_candles(db, "a")
    assert history == [
        dict(batch=1, o="100", h="100", l="100", c="100", v="10"),
        dict(batch=2, o="100", h="100", l="90", c="90", v="3"),
    ]
    assert market_candles(db, "a", 1) == history[-1:]
