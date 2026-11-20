"""Part B: Google Trends hourly interest for the top episodic memes, around each meme's launch peak.

Run:  uv run --no-project --with pytrends --with duckdb python3 packages/simulation/src/learned_markets_simulation/calibration/attention/google_trends.py
Reads  $LM_ATTN_OUT/meme_shape_stats.parquet. Writes $LM_ATTN_OUT/google_trends_hourly.csv and google_trends_fetch_log.json.
One request per meme (worldwide, search term = most common raw name of the cluster, window = peak -3 d .. +3 d,
which Google serves at hourly resolution). Slow pacing; stops after 3 consecutive failures (HTTP 429) instead of retrying.
Each series is scaled 0-100 within its own request, so levels are not comparable across memes.
"""
import os, sys, time, json, csv, datetime, random
import duckdb

OUT = os.environ.get("LM_ATTN_OUT", "/data/eren/learned-markets/calibration/attention")
TOP_N = int(os.environ.get("LM_TRENDS_TOP_N", "50"))
PACE_S = float(os.environ.get("LM_TRENDS_PACE_S", "20"))
BUDGET_S = float(os.environ.get("LM_TRENDS_BUDGET_S", "1200"))

con = duckdb.connect()
memes = con.execute(f"""select meme, display_name, peak_hour_ts, launches from '{OUT}/meme_shape_stats.parquet'
                        where cls = 'episodic' order by launches desc limit {TOP_N}""").fetchall()
from pytrends.request import TrendReq
py = TrendReq(hl="en-US", tz=0, timeout=(10, 30), retries=0)
now = datetime.datetime.now(datetime.timezone.utc)
fmt = lambda t: t.strftime("%Y-%m-%dT%H")
log, rows, fails, t0 = [], [], 0, time.time()
for meme, term, peak_ts, launches in memes:
    if time.time() - t0 > BUDGET_S:
        log.append(dict(meme=meme, status="skipped_time_budget")); continue
    if fails >= 3:
        log.append(dict(meme=meme, status="skipped_after_block")); continue
    pk = datetime.datetime.fromtimestamp(peak_ts, datetime.timezone.utc)
    a, b = pk - datetime.timedelta(days=3), min(pk + datetime.timedelta(days=3), now)
    term = term.strip()[:90]
    try:
        py.build_payload([term], timeframe=f"{fmt(a)} {fmt(b)}", geo="")
        df = py.interest_over_time()
        fails = 0
        if df is None or len(df) == 0:
            log.append(dict(meme=meme, term=term, status="empty"))
        else:
            for ts, r in df.iterrows():
                rows.append((meme, term, int(ts.timestamp()), int(r[term]), bool(r.get("isPartial", False))))
            log.append(dict(meme=meme, term=term, status="ok", n=len(df), max=int(df[term].max()), nonzero=int((df[term] > 0).sum())))
    except Exception as e:
        fails += 1
        log.append(dict(meme=meme, term=term, status="error", error=f"{type(e).__name__}: {str(e)[:200]}"))
    print(log[-1], flush=True)
    with open(f"{OUT}/google_trends_hourly.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["meme", "term", "hour_ts", "interest", "is_partial"]); w.writerows(rows)
    json.dump(log, open(f"{OUT}/google_trends_fetch_log.json", "w"), indent=1)
    time.sleep(PACE_S + random.uniform(0, 5))
print("ok:", sum(l["status"] == "ok" for l in log), "of", len(log))
