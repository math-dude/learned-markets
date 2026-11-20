"""True-value decay from distinct buyers at 5-minute bins (episodic core memes).

Run:  uv run --no-project --with duckdb --with numpy --with scipy python3 \\
        packages/simulation/src/learned_markets_simulation/calibration/attention/buyers_decay.py \\
        [--wallet-labels PATH.parquet --wallet-col wallet --label-col label --exclude-labels bot --tag nonbot]
Needs build_series.py and fit_shapes.py to have run (reads meme_mints.parquet, meme_shape_stats.parquet).
Env:  LM_EXPORT, LM_ATTN_OUT as in build_series.py.

Buys used:
  curve  pump_trades with is_buy (bonding curve)
  amm    PumpSwap amm_trades: is_buy where base_mint is one of the meme's mints, plus not is_buy where
         quote_mint is one of the meme's mints (pools quoted the other way round)
  all    both; a wallet buying on both venues in a bin counts once. This is the primary series.
Per meme, y = distinct buyers per 5-minute bin over all copies of the meme, zero-filled from the first buy to the
end of the window; b = median(y); s15 / s60 = 15-minute / 1-hour centred means.
  burst            run of bins with s60 >= b + max(3, 0.25*(max s60 - b)); runs < 6 h apart are merged
  main burst       the burst with the highest s60; peak = max of s15 inside it (+-30 min)
  rise_time_min    from the last bin before the peak where s15 < b + 10% of (peak - b), to the peak
  half_life_mass_min   excess buyers (y - b, floored at 0) after the peak bin up to main-burst end + 1 h: the delay
                   by which half of them have arrived (weighted median, interpolated inside the bin; needs >= 10)
  half_life_loglinear_min  ln2 / -slope of log(s15 - b) from peak to main-burst end (>= 4 points; > 1000 h dropped)
  burst_duration_min, reignition_gap_min (burst start to next burst start), n_bursts
  crowd_*          distinct buyer wallets deduplicated over the main burst / each burst / the whole window
Pooled decay: r_k = (y[peak+k] - b) / (s15[peak] - b) per meme, averaged over memes for lags 5 min .. 24 h, then
fitted in log space on about 30 log-spaced lags with a single exponential, a two-exponential mix and a power law
(AIC comparison).
"""
import argparse, json, math, os, re, time
import duckdb, numpy as np
from scipy.optimize import curve_fit

ap = argparse.ArgumentParser()
ap.add_argument("--wallet-labels", default=None, help="parquet with one row per wallet and a label column")
ap.add_argument("--wallet-col", default="wallet")
ap.add_argument("--label-col", default="label")
ap.add_argument("--exclude-labels", default="bot", help="comma separated labels whose buys are dropped")
ap.add_argument("--tag", default=None, help="suffix for outputs of a filtered run (default: 'non' + first excluded label)")
args = ap.parse_args()
EXPORT = os.environ.get("LM_EXPORT", "/data/ssd/jetstreamer/export")
OUT = os.environ.get("LM_ATTN_OUT", "/data/eren/learned-markets/calibration/attention")
TAG = (args.tag or "non" + args.exclude_labels.split(",")[0]) if args.wallet_labels else ""
SFX = f"_{TAG}" if TAG else ""
QS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]
BIN = 300
con = duckdb.connect(); con.execute("set threads=32"); t0 = time.time()

con.execute(f"""create table mints as select m.mint, m.meme from '{OUT}/meme_mints.parquet' m
   join (select meme from '{OUT}/meme_shape_stats.parquet'
         where cls = 'episodic' and not left_censored and not peak_right_censored and n_bursts > 0) using (meme)""")
con.execute(f"""create table buys as
  select m.meme, t."user" as wallet, t.timestamp as ts, 0::tinyint as venue
  from read_parquet('{EXPORT}/epoch=*/pump_trades.parquet', union_by_name=true) t join mints m on t.mint = m.mint where t.is_buy
  union all
  select m.meme, t."user", t.timestamp, 1::tinyint
  from read_parquet('{EXPORT}/epoch=*/amm_trades.parquet', union_by_name=true) t join mints m on t.base_mint = m.mint where t.is_buy
  union all
  select m.meme, t."user", t.timestamp, 1::tinyint
  from read_parquet('{EXPORT}/epoch=*/amm_trades.parquet', union_by_name=true) t join mints m on t.quote_mint = m.mint where not t.is_buy""")
n_raw = con.execute("select count(*), count(distinct wallet) from buys").fetchall()[0]
filt = None
if args.wallet_labels:
    cols = [r[0] for r in con.execute(f"describe select * from read_parquet('{args.wallet_labels}')").fetchall()]
    if args.wallet_col not in cols or args.label_col not in cols:
        raise SystemExit(f"label file columns are {cols}; pass --wallet-col/--label-col")
    ex = ",".join("'" + x.strip().replace("'", "") + "'" for x in args.exclude_labels.split(","))
    con.execute(f"""delete from buys where wallet in (select "{args.wallet_col}" from read_parquet('{args.wallet_labels}') where "{args.label_col}" in ({ex}))""")
    n_f = con.execute("select count(*), count(distinct wallet) from buys").fetchall()[0]
    filt = dict(label_file=args.wallet_labels, excluded_labels=args.exclude_labels, buys_before=n_raw[0], buys_after=n_f[0],
                wallets_before=n_raw[1], wallets_after=n_f[1])
print(f"buys={n_raw} by venue={con.execute('select venue, count(*), count(distinct wallet) from buys group by 1 order by 1').fetchall()} filter={filt} [{time.time()-t0:.0f}s]")
W1 = con.execute(f"select max(timestamp) from read_parquet('{EXPORT}/epoch=*/pump_trades.parquet', union_by_name=true)").fetchall()[0][0]
B1 = W1 // BIN

con.execute(f"""create table s5 as select meme, ts // {BIN} * {BIN} as bin_ts,
    count(distinct wallet) filter (where venue = 0) as buyers_curve, count(distinct wallet) filter (where venue = 1) as buyers_amm,
    count(distinct wallet) as buyers_all, count(*) filter (where venue = 0) as n_buys_curve, count(*) filter (where venue = 1) as n_buys_amm
    from buys group by 1, 2""")
con.execute(f"copy (select * from s5 order by meme, bin_ts) to '{OUT}/meme_buyers_5min{SFX}.parquet' (format parquet, compression zstd)")
print(f"5-min series rows={con.execute('select count(*) from s5').fetchall()[0][0]} [{time.time()-t0:.0f}s]")

def sm(x, k):
    return np.convolve(x, np.ones(k) / k, mode="same")

def shape(y):
    """y: dense 5-minute series. Returns (stats dict, list of bursts as (start, end) bin offsets, peak offset)."""
    b = float(np.median(y)); s15, s60 = sm(y, 3), sm(y, 12)
    thr = b + max(3.0, 0.25 * (s60.max() - b))
    idx = np.flatnonzero(s60 >= thr)
    if len(idx) == 0:
        return None, [], None
    runs, st, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - prev - 1 >= 72:
            runs.append((int(st), int(prev))); st = i
        prev = i
    runs.append((int(st), int(prev)))
    a, e = max(runs, key=lambda r: s60[r[0]:r[1] + 1].max())
    lo = max(a - 6, 0); pk = lo + int(np.argmax(s15[lo:min(e + 6, len(y) - 1) + 1]))
    amp = s15[pk] - b
    j = pk
    while j > 0 and s15[j] >= b + 0.1 * amp: j -= 1
    hi = min(max(e, pk) + 12, len(y) - 1)
    w = np.clip(y[pk + 1:hi + 1] - b, 0, None); hl_mass = float("nan")
    if w.sum() >= 10:
        c = np.cumsum(w); k = int(np.searchsorted(c, c[-1] / 2.0)); prevc = c[k - 1] if k else 0.0
        hl_mass = (k + 0.5 + (c[-1] / 2.0 - prevc) / w[k]) * 5.0
    hl_fit = float("nan"); z = s15[pk:max(e, pk) + 1] - b; ok = z > 0
    if ok.sum() >= 4:
        sl = np.polyfit(np.arange(len(z))[ok] * 5.0, np.log(z[ok]), 1)[0]
        if sl < -math.log(2) / 60000: hl_fit = math.log(2) / -sl
    st = dict(baseline_per_5min=b, peak_buyers_per_5min=float(y[max(pk - 1, 0):pk + 2].max()), peak_s15=float(s15[pk]),
              time_to_peak_min=pk * 5.0, rise_time_min=(pk - j) * 5.0, half_life_mass_min=hl_mass, half_life_loglinear_min=hl_fit,
              burst_duration_min=(e - a + 1) * 5.0, n_bursts=len(runs), peak_censored=bool(pk >= len(y) - 288))
    return st, runs, pk

LAGS = 288
stats, bursts, prof = [], [], []
rows = con.execute("select meme, bin_ts // 300, buyers_curve, buyers_amm, buyers_all from s5 order by meme, bin_ts").fetchall()
by = {}
for m, bn, c, a, al in rows: by.setdefault(m, []).append((bn, c, a, al))
for m, v in by.items():
    v = np.array(v, dtype=np.int64); f0 = int(v[0, 0]); n = int(B1 - f0 + 1)
    row = dict(meme=m, first_bin_ts=f0 * BIN)
    for col, name in [(3, "all"), (1, "curve"), (2, "amm")]:
        y = np.zeros(n); y[v[:, 0] - f0] = v[:, col]
        if y.sum() == 0: continue
        st, runs, pk = shape(y)
        if st is None:
            if name == "all": row["n_bursts"] = 0
            continue
        if name == "all":
            row.update(st); row["peak_ts"] = (f0 + pk) * BIN
            main = max(runs, key=lambda r: sm(y, 12)[r[0]:r[1] + 1].max())
            for i, (a, e) in enumerate(runs):
                bursts.append(dict(meme=m, burst_no=i, start_ts=(f0 + a) * BIN, end_ts=(f0 + e + 1) * BIN, is_main=(a, e) == main,
                                   duration_min=(e - a + 1) * 5.0, gap_from_prev_start_min=(a - runs[i - 1][0]) * 5.0 if i else None))
            b = st["baseline_per_5min"]; amp = st["peak_s15"] - b
            if not st["peak_censored"] and amp > 0:
                r = np.full(LAGS + 1, np.nan); seg = y[pk:pk + LAGS + 1]; r[:len(seg)] = (seg - b) / amp; prof.append(r)
        else:
            for k in ["half_life_mass_min", "half_life_loglinear_min", "rise_time_min", "burst_duration_min", "peak_buyers_per_5min", "n_bursts"]:
                row[f"{name}_{k}"] = st[k]
    stats.append(row)

# deduplicated crowd sizes
con.execute("create table bursts (meme varchar, burst_no int, start_ts bigint, end_ts bigint, is_main boolean, duration_min double, gap_from_prev_start_min double)")
con.executemany("insert into bursts values (?,?,?,?,?,?,?)", [[r[k] for k in ["meme", "burst_no", "start_ts", "end_ts", "is_main", "duration_min", "gap_from_prev_start_min"]] for r in bursts])
con.execute("""create table bc as select b.meme, b.burst_no, any_value(b.is_main) is_main, any_value(b.start_ts) start_ts, any_value(b.end_ts) end_ts,
    any_value(b.duration_min) duration_min, any_value(b.gap_from_prev_start_min) gap_from_prev_start_min,
    count(distinct x.wallet) crowd, count(distinct x.wallet) filter (where x.venue = 0) crowd_curve,
    count(distinct x.wallet) filter (where x.venue = 1) crowd_amm, count(*) n_buys
    from bursts b join buys x on x.meme = b.meme and x.ts >= b.start_ts and x.ts < b.end_ts group by 1, 2""")
con.execute(f"copy (select * from bc order by meme, burst_no) to '{OUT}/meme_buyer_bursts{SFX}.parquet' (format parquet)")
bc = con.execute("select meme, burst_no, is_main, crowd, crowd_curve, crowd_amm, n_buys, gap_from_prev_start_min, duration_min from bc").fetchall()
whole = dict((r[0], r[1:]) for r in con.execute("""select meme, count(distinct wallet), count(distinct wallet) filter (where venue=0),
    count(distinct wallet) filter (where venue=1) from buys group by 1""").fetchall())
mainc = {r[0]: r for r in bc if r[2]}
for r in stats:
    w = whole[r["meme"]]; r["crowd_whole_window"], r["crowd_whole_window_curve"], r["crowd_whole_window_amm"] = w
    if r["meme"] in mainc:
        q_ = mainc[r["meme"]]
        r["crowd_main_burst"], r["crowd_main_burst_curve"], r["crowd_main_burst_amm"], r["buys_main_burst"] = q_[3], q_[4], q_[5], q_[6]
keys = []
for r in stats:
    for k in r:
        if k not in keys: keys.append(k)
con.execute("create table st (" + ", ".join(f'"{k}" ' + ("varchar" if k == "meme" else "boolean" if k == "peak_censored" else "double") for k in keys) + ")")
con.executemany("insert into st values (" + ",".join("?" * len(keys)) + ")",
                [[None if isinstance(r.get(k), float) and math.isnan(r.get(k)) else r.get(k) for k in keys] for r in stats])
con.execute(f"copy st to '{OUT}/meme_buyer_shape_stats{SFX}.parquet' (format parquet)")
print(f"shapes done, memes={len(stats)} bursts={len(bursts)} [{time.time()-t0:.0f}s]")

def q(vals):
    v = np.array([z for z in vals if z is not None and not (isinstance(z, float) and math.isnan(z))], dtype=float)
    if len(v) == 0: return dict(n=0)
    d = dict(n=int(len(v)), mean=round(float(v.mean()), 2))
    for p, z in zip(QS, np.quantile(v, QS)): d[f"q{int(p*100):02d}"] = round(float(z), 2)
    return d

core = [r for r in stats if r.get("n_bursts", 0) > 0 and not r.get("peak_censored", True)]
cm = {r["meme"] for r in core}
g = lambda k: q([r.get(k) for r in core])

# ---- pooled, peak-normalised decay ------------------------------------------------------------
P = np.array(prof); t = np.arange(1, LAGS + 1) * 5.0
mean_prof = np.nanmean(P, axis=0); med_prof = np.nanmedian(P, axis=0)
with open(f"{OUT}/buyers_decay_profile{SFX}.csv", "w") as f:
    f.write("lag_min,mean_frac_of_peak,median_frac_of_peak,n_memes\n")
    for k in range(LAGS + 1):
        f.write(f"{k*5},{mean_prof[k]:.6f},{med_prof[k]:.6f},{int(np.isfinite(P[:, k]).sum())}\n")
f_exp = lambda t, la, tau: la - t / tau
f_two = lambda t, la, w, t1, t2: la + np.log(w * np.exp(-t / t1) + (1 - w) * np.exp(-t / t2))
f_pow = lambda t, la, t0_, al: la - al * np.log1p(t / t0_)
def fit_forms(profile):
    sel = np.unique(np.round(np.geomspace(1, LAGS, 40)).astype(int)) - 1   # log-spaced lags, so the first hour is not swamped by the tail
    ok = profile[1:][sel] > 0; x, ly = t[sel][ok], np.log(profile[1:][sel][ok]); n = len(x); out = {}
    specs = [("single_exponential", f_exp, [0, 100], ([-5, 1], [5, 1e5]), ["log_amp", "tau_min"]),
             ("two_exponential", f_two, [0, 0.7, 20, 600], ([-5, 0.01, 1, 30], [5, 0.99, 300, 1e5]), ["log_amp", "weight_fast", "tau_fast_min", "tau_slow_min"]),
             ("power_law", f_pow, [0, 10, 1], ([-5, 0.01, 0.05], [5, 1e4, 10]), ["log_amp", "t0_min", "alpha"])]
    for name, fn, p0, bounds, names in specs:
        try:
            p, _ = curve_fit(fn, x, ly, p0=p0, bounds=bounds, maxfev=20000)
            rss = float(((fn(x, *p) - ly) ** 2).sum())
            d = {k: round(float(v), 4) for k, v in zip(names, p)}
            d["amplitude"] = round(math.exp(d.pop("log_amp")), 4)
            if name == "single_exponential": d["half_life_min"] = round(d["tau_min"] * math.log(2), 2)
            if name == "two_exponential":
                d["half_life_fast_min"] = round(d["tau_fast_min"] * math.log(2), 2); d["half_life_slow_min"] = round(d["tau_slow_min"] * math.log(2), 2)
            d.update(log_rmse=round(math.sqrt(rss / n), 4), aic=round(n * math.log(rss / n) + 2 * len(p), 1), n_lags=n)
            out[name] = d
        except Exception as ex:
            out[name] = dict(error=str(ex)[:100])
    best = min((k for k in out if "aic" in out[k]), key=lambda k: out[k]["aic"])
    return best, out
best, fits = fit_forms(mean_prof)
best_med, fits_med = fit_forms(med_prof)
frac_at = {f"{m}min": round(float(mean_prof[m // 5]), 4) for m in [5, 15, 30, 60, 120, 360, 720, 1440]}
frac_at_med = {f"{m}min": round(float(med_prof[m // 5]), 4) for m in [5, 15, 30, 60, 120, 360, 720, 1440]}

section = dict(
    description="distinct buyers per 5-minute bin over all copies of a meme; bonding-curve plus PumpSwap buys combined unless a key says curve or amm",
    generated_by="buyers_decay.py", wallet_filter=filt or "none (all wallets, bots included)", time_unit="minutes", bin_minutes=5,
    quantile_levels=QS, n_memes_input=len(by), n_memes_with_burst_uncensored=len(core),
    decay_form_best=best,
    decay_formula={"single_exponential": "frac(t) = amplitude * exp(-t / tau_min)",
                   "two_exponential": "frac(t) = amplitude * (weight_fast * exp(-t / tau_fast_min) + (1 - weight_fast) * exp(-t / tau_slow_min))",
                   "power_law": "frac(t) = amplitude * (1 + t / t0_min) ** (-alpha)"}[best] + "; t = minutes after the buyer peak, frac = excess buyers per 5 min over baseline, relative to the peak",
    decay_params=fits[best], decay_fit_single_exponential=fits["single_exponential"], decay_fit_two_exponential=fits["two_exponential"],
    decay_fit_power_law=fits["power_law"], decay_form_best_on_median_profile=best_med, decay_fits_on_median_profile=fits_med,
    decay_mean_frac_of_peak_at=frac_at, decay_median_frac_of_peak_at=frac_at_med,
    half_life_mass_min=g("half_life_mass_min"), half_life_loglinear_min=g("half_life_loglinear_min"),
    rise_time_min=g("rise_time_min"), time_to_peak_from_first_buy_min=g("time_to_peak_min"),
    burst_duration_min=q([r[8] for r in bc if r[0] in cm]), main_burst_duration_min=g("burst_duration_min"),
    reignition_gap_min=q([r[7] for r in bc if r[0] in cm and r[7] is not None]),
    n_bursts=g("n_bursts"), peak_buyers_per_5min=g("peak_buyers_per_5min"), baseline_buyers_per_5min=g("baseline_per_5min"),
    crowd_main_burst=g("crowd_main_burst"), crowd_per_burst=q([r[3] for r in bc if r[0] in cm]), crowd_whole_window=g("crowd_whole_window"),
    crowd_main_burst_curve=g("crowd_main_burst_curve"), crowd_main_burst_amm=g("crowd_main_burst_amm"),
    crowd_whole_window_curve=g("crowd_whole_window_curve"), crowd_whole_window_amm=g("crowd_whole_window_amm"),
    buys_main_burst=g("buys_main_burst"),
    curve_half_life_mass_min=g("curve_half_life_mass_min"), amm_half_life_mass_min=g("amm_half_life_mass_min"),
    curve_half_life_loglinear_min=g("curve_half_life_loglinear_min"), amm_half_life_loglinear_min=g("amm_half_life_loglinear_min"),
    curve_rise_time_min=g("curve_rise_time_min"), amm_rise_time_min=g("amm_rise_time_min"),
    curve_burst_duration_min=g("curve_burst_duration_min"), amm_burst_duration_min=g("amm_burst_duration_min"),
    curve_peak_buyers_per_5min=g("curve_peak_buyers_per_5min"), amm_peak_buyers_per_5min=g("amm_peak_buyers_per_5min"),
)
pj = f"{OUT}/attention_params.json"; params = json.load(open(pj)) if os.path.exists(pj) else {}
key = "buyers" + SFX; params[key] = section
if TAG and "buyers" in params:
    base = params["buyers"]
    params[key + "_vs_unfiltered_median_ratio"] = {k: round(section[k]["q50"] / base[k]["q50"], 3) for k in section
        if isinstance(section[k], dict) and "q50" in section[k] and isinstance(base.get(k), dict) and base[k].get("q50")}
json.dump(params, open(pj, "w"), indent=1)

TBL = ["half_life_mass_min", "half_life_loglinear_min", "rise_time_min", "time_to_peak_from_first_buy_min", "main_burst_duration_min", "burst_duration_min",
       "reignition_gap_min", "n_bursts", "peak_buyers_per_5min", "crowd_main_burst", "crowd_per_burst", "crowd_whole_window",
       "crowd_main_burst_curve", "crowd_main_burst_amm", "curve_half_life_mass_min", "amm_half_life_mass_min", "curve_rise_time_min",
       "amm_rise_time_min", "curve_burst_duration_min", "amm_burst_duration_min", "curve_peak_buyers_per_5min", "amm_peak_buyers_per_5min"]
md = [f"<!-- BUYERS{SFX} START -->", f"## Buyers at 5-minute bins{' (' + TAG + ')' if TAG else ''}", "",
      f"Generated by `buyers_decay.py`. {len(by)} episodic core memes with buys, {len(core)} with a buyer burst whose peak is not in the last 24 h. "
      f"Wallet filter: {section['wallet_filter']}. Times in minutes. Definitions are in the script docstring.", "",
      "| statistic | n | mean | " + " | ".join(f"q{int(p*100):02d}" for p in QS) + " |", "|---|---|---|" + "---|" * len(QS)]
for k in TBL:
    d = section[k]
    if d.get("n"): md.append(f"| {k} | {d['n']} | {d['mean']} | " + " | ".join(str(d[f"q{int(p*100):02d}"]) for p in QS) + " |")
md += ["", f"Pooled peak-normalised decay (mean over memes, log-spaced lags from 5 min to 24 h, log-space fit). Best by AIC: **{best}**.", "",
       "| form | parameters | log RMSE | AIC |", "|---|---|---|---|"]
for k, d in fits.items():
    md.append(f"| {k} | " + ", ".join(f"{a}={b}" for a, b in d.items() if a not in ("log_rmse", "aic", "n_lags")) + f" | {d.get('log_rmse')} | {d.get('aic')} |")
md += ["", f"Mean fraction of peak remaining: {frac_at}", "", f"Median fraction of peak remaining: {frac_at_med}", "",
       f"On the median profile the best form is {best_med}: {fits_med.get(best_med)}", ""]
if TAG and key + "_vs_unfiltered_median_ratio" in params:
    md += [f"Filter effect: {filt}", "", f"Median ratio, filtered / unfiltered: {params[key + '_vs_unfiltered_median_ratio']}", ""]
md += [f"<!-- BUYERS{SFX} END -->"]
block = "\n".join(md); sp = f"{OUT}/summary.md"; txt = open(sp).read() if os.path.exists(sp) else ""
pat = re.compile(rf"<!-- BUYERS{SFX} START -->.*?<!-- BUYERS{SFX} END -->", re.S)
txt = pat.sub(lambda _: block, txt) if pat.search(txt) else txt.rstrip("\n") + "\n\n" + block + "\n"
open(sp, "w").write(txt)
print(block)
