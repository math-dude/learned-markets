"""Part B analysis: correlation and lead/lag between Google Trends interest and the launch-count proxy.

Run:  uv run --no-project --with duckdb --with numpy python3 packages/simulation/src/learned_markets_simulation/calibration/attention/trends_vs_launches.py
Reads  $LM_ATTN_OUT/google_trends_hourly.csv and meme_hourly.parquet
Writes $LM_ATTN_OUT/google_trends_vs_launches.csv and google_trends_summary.md
lag convention: best_lag_h > 0 means Google Trends moves first (trends[t] lines up with launches[t + lag]).
Series are 3 h centred means; lags searched in -24..+24 h. A meme is 'usable' if Trends is nonzero in >= 24 hours
and there are >= 48 overlapping hours inside the on-chain window.
"""
import os, csv, json
import duckdb, numpy as np
OUT = os.environ.get("LM_ATTN_OUT", "/data/eren/learned-markets/calibration/attention")
con = duckdb.connect()
w0, w1 = con.execute(f"select min(hour_ts), max(hour_ts) from '{OUT}/meme_hourly.parquet'").fetchall()[0]
tr = {}
for r in csv.DictReader(open(f"{OUT}/google_trends_hourly.csv")):
    tr.setdefault(r["meme"], {})[int(r["hour_ts"])] = float(r["interest"])
sm = lambda x: np.convolve(x, np.ones(3) / 3, mode="same")
def corr(a, b):
    return float(np.corrcoef(a, b)[0, 1]) if len(a) > 10 and a.std() > 0 and b.std() > 0 else float("nan")
out = []
for meme, t in tr.items():
    la = dict(con.execute(f"select hour_ts, launches from '{OUT}/meme_hourly.parquet' where meme = ?", [meme]).fetchall())
    hrs = [h for h in sorted(t) if w0 < h < w1]          # drop partial edge bins
    g = np.array([t[h] for h in hrs]); x = np.array([float(la.get(h, 0)) for h in hrs])
    row = dict(meme=meme, hours=len(hrs), trends_nonzero_hours=int((g > 0).sum()), launches_in_window=int(x.sum()))
    row["usable"] = bool(len(hrs) >= 48 and row["trends_nonzero_hours"] >= 24 and x.sum() > 0)
    if row["usable"]:
        gs, xs = sm(g), sm(x)
        row["corr_lag0"] = corr(gs, xs)
        best = (float("-inf"), 0)
        for k in range(-24, 25):
            c = corr(gs[:len(gs) - k], xs[k:]) if k >= 0 else corr(gs[-k:], xs[:len(xs) + k])
            if c == c and c > best[0]: best = (c, k)
        row["best_corr"], row["best_lag_h"] = best
        row["launch_peak_minus_trends_peak_h"] = int(np.argmax(xs) - np.argmax(gs))
        # same after removing the average hour-of-day profile of the Trends series (generic words are diurnal)
        hod = np.array([(h // 3600) % 24 for h in hrs]); gd = g.copy()
        for hh in range(24):
            if (hod == hh).any(): gd[hod == hh] -= np.median(g[hod == hh])
        row["corr_lag0_dediurnal"] = corr(sm(gd), xs)
    out.append(row)
cols = ["meme", "usable", "hours", "trends_nonzero_hours", "launches_in_window", "corr_lag0", "corr_lag0_dediurnal", "best_corr", "best_lag_h", "launch_peak_minus_trends_peak_h"]
with open(f"{OUT}/google_trends_vs_launches.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(out)
U = [r for r in out if r["usable"]]
log = json.load(open(f"{OUT}/google_trends_fetch_log.json"))
st = {}
for l in log: st[l["status"]] = st.get(l["status"], 0) + 1
qq = lambda k: [round(float(z), 3) for z in np.nanquantile([r[k] for r in U], [0.1, 0.25, 0.5, 0.75, 0.9])] if U else []
md = ["# Google Trends vs launch-count proxy", "", f"Fetch status counts: {st}. Memes with data: {len(out)}; usable: {len(U)}.", "",
      "Quantiles (q10, q25, q50, q75, q90) across usable memes:", "",
      f"- corr at lag 0 (3 h means): {qq('corr_lag0')}", f"- corr at lag 0, Trends hour-of-day profile removed: {qq('corr_lag0_dediurnal')}",
      f"- best corr over lags -24..+24 h: {qq('best_corr')}", f"- best lag in hours (positive = Trends leads launches): {qq('best_lag_h')}",
      f"- launch peak minus Trends peak, hours: {qq('launch_peak_minus_trends_peak_h')}", "",
      f"Share of usable memes with corr_lag0 > 0.3: {np.mean([r['corr_lag0'] > 0.3 for r in U]) if U else 'n/a'}", "",
      "| meme | corr lag0 | dediurnal | best corr | best lag h | launch peak - trends peak h | trends nonzero h |", "|---|---|---|---|---|---|---|"]
for r in sorted(U, key=lambda r: -r["corr_lag0"]):
    md.append(f"| {r['meme']} | {r['corr_lag0']:.2f} | {r['corr_lag0_dediurnal']:.2f} | {r['best_corr']:.2f} | {r['best_lag_h']} | {r['launch_peak_minus_trends_peak_h']} | {r['trends_nonzero_hours']} |")
open(f"{OUT}/google_trends_summary.md", "w").write("\n".join(md) + "\n")
print("\n".join(md))
