"""Integer-exact OHLCV of confirmed batches, shared by chart consumers."""

import json


def market_candles(db, market, limit=240):
    # Include the preceding batch to retain the opening price at a range boundary.
    rows = db.execute(
        """SELECT batch, details FROM web_orders
        WHERE market=? AND status='filled' AND signature IS NOT NULL
        AND batch IN (SELECT DISTINCT batch FROM web_orders
          WHERE market=? AND status='filled' AND signature IS NOT NULL
          ORDER BY batch DESC LIMIT ?)
        ORDER BY batch,rowid""",
        (market, market, limit + 1),
    ).fetchall()
    candles = {}
    previous = None
    for row in rows:
        detail = json.loads(row["details"])
        if not detail.get("clearing_price"):
            continue
        price = int(detail["clearing_price"])
        batch = row["batch"]
        if batch not in candles:
            opening = previous if previous is not None else price
            candles[batch] = {
                "batch": batch,
                "o": str(opening),
                "h": str(max(opening, price)),
                "l": str(min(opening, price)),
                "c": str(price),
                "v": "0",
            }
        candle = candles[batch]
        if int(candle["c"]) != price:
            raise ValueError("Conflicting confirmed prices in one settlement batch")
        candle["v"] = str(int(candle["v"]) + int(detail["quantity"]))
        previous = price
    return list(candles.values())[-limit:]
