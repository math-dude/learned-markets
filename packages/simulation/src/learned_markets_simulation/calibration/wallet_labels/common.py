"""Shared paths and helpers for the wallet-labelling scripts."""
import os
import sys

import duckdb

EXPORT = os.environ.get("LM_EXPORT", "/data/ssd/jetstreamer/export")
HERE = os.path.dirname(os.path.abspath(__file__))


def out_dir():
    """All outputs (parquet, CSV label table, summary.md). Override with LM_LABEL_OUT."""
    d = os.environ.get("LM_LABEL_OUT", "/data/eren/learned-markets/calibration/wallet_labels")
    os.makedirs(d, exist_ok=True)
    return d


def parse_epochs(argv):
    """Accepts `1086 1087`, `1086-1088`, `1086,1088` or a mix."""
    eps = []
    for a in argv:
        for part in a.split(","):
            if "-" in part:
                lo, hi = part.split("-")
                eps += range(int(lo), int(hi) + 1)
            elif part:
                eps.append(int(part))
    if not eps:
        raise SystemExit(f"usage: {sys.argv[0]} <epochs, e.g. 1086-1088>")
    return sorted(set(eps))


def files(table, epochs):
    return "[" + ",".join(f"'{EXPORT}/epoch={e}/{table}.parquet'" for e in epochs) + "]"


def connect():
    con = duckdb.connect()
    # LM_DUCKDB_TMP_MAX caps the spill: a query that needs more fails instead of filling the disk.
    con.execute(f"set memory_limit='{os.environ.get('LM_DUCKDB_MEM', '60GB')}'")
    con.execute(f"set threads={os.environ.get('LM_DUCKDB_THREADS', '40')}")
    con.execute(f"set temp_directory='{out_dir()}/duckdb_tmp'")
    con.execute(f"set max_temp_directory_size='{os.environ.get('LM_DUCKDB_TMP_MAX', '10GB')}'")
    con.execute("set preserve_insertion_order=false")
    return con


# Programs that never play the "router" role.
INFRA = {
    "11111111111111111111111111111111": "System",
    "ComputeBudget111111111111111111111111111111": "ComputeBudget",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "SPL Token",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": "Token-2022",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "Associated Token",
    "Memo1UhkJRfHyvLMcVucJwxXeuD728EV2ifVVAKrVKo": "Memo v1",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr": "Memo v2",
    "AddressLookupTab1e1111111111111111111111111": "Address Lookup Table",
    "Ed25519SigVerify111111111111111111111111111": "Ed25519 verify",
    "KeccakSecp256k11111111111111111111111111111": "Secp256k1 verify",
    "Secp256r1SigVerify1111111111111111111111111": "Secp256r1 verify",
}
PUMP = {
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun bonding curve",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap AMM",
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ": "pump fee program",
}
