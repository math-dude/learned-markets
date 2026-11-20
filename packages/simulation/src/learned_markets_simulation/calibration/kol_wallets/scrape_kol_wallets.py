"""Scrape KOL (influencer) wallet addresses from kolscan.io into kol_wallets.csv.

Run:  uv run --with httpx python3 packages/simulation/src/learned_markets_simulation/calibration/kol_wallets/scrape_kol_wallets.py

kolscan.io is a Next.js app that embeds its data in the page HTML (React
flight payload, `self.__next_f.push`). One plain GET of /leaderboard gives:
  - `initialData`     the full KOL roster (wallet, name, socials), from the layout
  - `initLeaderboard` profit / wins / losses per wallet for timeframes 1, 7, 30 days
No login, no API key, no bot protection involved. We make a single request.
"""

import base64
import csv
import datetime as dt
import json
import pathlib
import re
import sys

import httpx

URL = "https://kolscan.io/leaderboard"
OUT = pathlib.Path("/data/eren/learned-markets/calibration/kol_wallets") / "kol_wallets.csv"
UA = "Mozilla/5.0 (X11; Linux x86_64) learned-markets-research/0.1"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
TIMEFRAMES = {1: "1d", 7: "7d", 30: "30d"}


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)  # ValueError on a non-base58 character
    pad = len(s) - len(s.lstrip("1"))
    return b"\0" * pad + n.to_bytes((n.bit_length() + 7) // 8, "big")


def is_solana_pubkey(s: str) -> bool:
    try:
        return 32 <= len(s) <= 44 and len(b58decode(s)) == 32
    except ValueError:
        return False


def flight_payload(html: str) -> str:
    """Concatenate the string chunks of the React flight payload."""
    chunks = re.findall(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)', html)
    return "".join(json.loads(c) for c in chunks)


def arrays_after(payload: str, key: str) -> list[list[dict]]:
    """Every JSON array that follows `"key":` in the payload."""
    dec = json.JSONDecoder()
    out = []
    for m in re.finditer(re.escape(f'"{key}":') + r"(?=\[)", payload):
        arr, _ = dec.raw_decode(payload, m.end())
        out.append(arr)
    return out


def main() -> int:
    r = httpx.get(URL, headers={"User-Agent": UA}, timeout=30, follow_redirects=True)
    r.raise_for_status()
    fetched_at = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = flight_payload(r.text)

    rows: dict[str, dict] = {}
    invalid = []

    def row(e: dict) -> dict | None:
        w = e.get("wallet_address")
        if not isinstance(w, str) or not is_solana_pubkey(w):
            invalid.append(w)
            return None
        d = rows.setdefault(w, {"wallet": w, "source": "kolscan.io", "fetched_at": fetched_at,
                                "source_url": f"https://kolscan.io/account/{w}"})
        for k in ("name", "twitter", "telegram", "twitch", "kick"):
            if e.get(k) and not d.get(k):
                d[k] = e[k].strip()
        return d

    rosters = arrays_after(payload, "initialData")
    boards = arrays_after(payload, "initLeaderboard")
    if not rosters and not boards:
        print("no embedded data found; page layout changed or fetch was blocked", file=sys.stderr)
        return 1
    for arr in rosters:
        for e in arr:
            d = row(e)
            if d is not None:
                d["in_roster"] = 1
    for arr in boards:
        for e in arr:
            d = row(e)
            tf = TIMEFRAMES.get(e.get("timeframe"))
            if d is None or tf is None:
                continue
            d[f"pnl_sol_{tf}"] = e.get("profit")
            d[f"wins_{tf}"] = e.get("wins")
            d[f"losses_{tf}"] = e.get("losses")

    cols = ["wallet", "name", "source", "source_url", "twitter", "fetched_at",
            "telegram", "twitch", "kick", "in_roster"]
    for tf in TIMEFRAMES.values():
        cols += [f"pnl_sol_{tf}", f"wins_{tf}", f"losses_{tf}"]
    with OUT.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for d in sorted(rows.values(), key=lambda d: (d.get("name") or "").lower()):
            w.writerow({c: d.get(c, "") for c in cols})

    n_board = sum(1 for d in rows.values() if any(k.startswith("pnl_") for k in d))
    print(f"wrote {len(rows)} wallets to {OUT} "
          f"({sum(1 for d in rows.values() if d.get('in_roster'))} in roster, "
          f"{n_board} with leaderboard stats, {len(invalid)} invalid dropped: {invalid[:5]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
