"""Part A step 2: per-meme shape statistics, cross-meme quantiles, new-meme arrival rate.

Run:  uv run --no-project --with duckdb --with numpy python3 packages/simulation/src/learned_markets_simulation/calibration/attention/fit_shapes.py
Reads  $LM_ATTN_OUT/{meme_hourly,clusters_all}.parquet (from build_series.py)
Writes $LM_ATTN_OUT/{meme_shape_stats,meme_bursts}.parquet, attention_params.json, summary.md

Definitions (x = launches per hour for one meme, from its first launch hour to the end of the window):
  s            3-hour centred moving average of x
  b            baseline = median of x over the meme's observed life (0 for most memes)
  peak         hour of max s. time_to_peak_h = hours from first-launch hour to that hour
  peak_height  max raw x (launches in the best single hour); peak_s = max s
  half_life_h  hours after the peak until s first drops to b + (peak_s - b)/2, linearly interpolated;
               NaN (censored) if that never happens inside the window
  half_life_fit_h  ln2 / -slope of a least-squares line through log(s - b) from the peak to the end of
               the peak's burst (needs >= 3 points; fits slower than 1000 h are discarded)
  half_life_10min_h  same crossing rule as half_life_h but on 10-minute bins with a 30-minute centred mean
               (y = launches per 10 min, baseline = median of y). The hourly half_life_h cannot resolve
               anything faster than about 1 h, so prefer this one for fast decays.
  half_life_mass_h  no smoothing: take the launches of the peak's burst (hourly burst window, +1 h) that come
               after the middle of the peak 10-minute bin; the median of their delays. For an exponential
               decay the median delay equals the half-life. Needs >= 4 such launches.
  time_to_peak_10min_h  first launch to the peak 10-minute bin, in hours
  burst        maximal run of hours with s >= b + max(1, 0.25*(peak_s - b)); runs separated by < 6 quiet
               hours are merged. n_bursts counts them (0 = never 3 launches inside any 3 h window).
  onset_jump   per burst: the largest hour-over-hour increase of raw x from the hour before the burst to
               its peak (launches/h), also as a fraction of that burst's raw peak
  rise_h       per burst: hours from burst start to burst peak
Classes:
  single_actor  top launcher wallet has >= 50% of launches, or < 5 distinct launcher wallets  (excluded)
  evergreen     launched in >= 200 of the 412 hours (names that bots relaunch around the clock)
  episodic      everything else  (the class to calibrate rise/decay from)
"""
import json, os, math, datetime
import duckdb, numpy as np

OUT = os.environ.get("LM_ATTN_OUT", "/data/eren/learned-markets/calibration/attention")
QS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]
BURN_IN_H, RUNWAY_H, EDGE_H = 48, 72, 24
con = duckdb.connect()

clusters = con.execute(f"""select meme, display_name, display_symbol, launches, distinct_launchers, first_ts, last_ts,
    active_hours, launches_72h, top_launcher_share, prolific_share from '{OUT}/clusters_all.parquet'""").fetchall()
ccols = ["meme", "display_name", "display_symbol", "launches", "distinct_launchers", "first_ts", "last_ts",
         "active_hours", "launches_72h", "top_launcher_share", "prolific_share"]
clusters = [dict(zip(ccols, r)) for r in clusters]
W0 = min(c["first_ts"] for c in clusters); W1 = max(c["last_ts"] for c in clusters)
H0 = W0 // 3600 * 3600; NH = (W1 // 3600 * 3600 - H0) // 3600 + 1
cmeta = {c["meme"]: c for c in clusters}

rows = con.execute(f"select meme, hour_ts, launches, distinct_launchers, distinct_buyers, sol_volume from '{OUT}/meme_hourly.parquet' order by meme, hour_ts").fetchall()
ltimes = {}
for m, t in con.execute(f"select meme, ts from '{OUT}/meme_launch_times.parquet'").fetchall():
    ltimes.setdefault(m, []).append(t)
series = {}
for m, h, l, dl, db, sv in rows:
    series.setdefault(m, []).append((l, dl, db, sv))

def smooth(x):
    return np.convolve(x, np.ones(3) / 3.0, mode="same")

def half_life(s, b, pk):
    half = b + (s[pk] - b) / 2.0
    for j in range(pk + 1, len(s)):
        if s[j] <= half:
            return (j - 1 - pk) + (s[j - 1] - half) / max(s[j - 1] - s[j], 1e-12)
    return float("nan")

def bursts_of(x, s, b):
    thr = b + max(1.0, 0.25 * (s.max() - b))
    idx = np.flatnonzero(s >= thr)
    if len(idx) == 0:
        return []
    runs, st, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - prev - 1 >= 6:
            runs.append((st, prev)); st = i
        prev = i
    runs.append((st, prev))
    out = []
    for a, e in runs:
        pk = a + int(np.argmax(s[a:e + 1]))
        seg = x[max(a - 1, 0):pk + 2]                      # hour before the burst .. hour after smoothed peak
        d = np.diff(np.concatenate([[0.0] if a == 0 else [], seg]))
        rawpk = float(x[max(a - 1, 0):e + 2].max())
        jump = float(d.max()) if len(d) else float(seg.max())
        out.append(dict(start=int(a), end=int(e), peak=int(pk), peak_s=float(s[pk]), raw_peak=rawpk,
                        dur_h=int(e - a + 1), rise_h=int(pk - a), jump=jump,
                        jump_frac=jump / rawpk if rawpk > 0 else float("nan"),
                        launches=float(x[a:e + 1].sum())))
    return out

stats, burst_rows = [], []
for m, v in series.items():
    a = np.array(v, dtype=float)
    x, buyers, vol = a[:, 0], a[:, 2], a[:, 3]
    c = cmeta[m]; L = len(x); first_idx = NH - L
    s = smooth(x); b = float(np.median(x)); pk = int(np.argmax(s))
    bs = bursts_of(x, s, b)
    main = next((q for q in bs if q["start"] <= pk <= q["end"]), None)
    hl_fit = float("nan")
    if main is not None and main["end"] - pk + 1 >= 3:
        y = s[pk:main["end"] + 1] - b
        if (y > 0).all():
            sl = np.polyfit(np.arange(len(y)), np.log(y), 1)[0]
            if sl < -math.log(2) / 1000: hl_fit = math.log(2) / -sl
    cls = ("single_actor" if (c["top_launcher_share"] >= 0.5 or c["distinct_launchers"] < 5)
           else "evergreen" if c["active_hours"] >= 200 else "episodic")
    sb = smooth(buyers); bpk = int(np.argmax(sb)); bb = float(np.median(buyers))
    corr = float(np.corrcoef(x, buyers)[0, 1]) if x.std() > 0 and buyers.std() > 0 else float("nan")
    hl = half_life(s, b, pk)
    t10 = np.array(ltimes[m]); y = np.bincount((t10 - t10[0]) // 600, minlength=(W1 - t10[0]) // 600 + 1).astype(float)
    s10 = smooth(y); pk10 = int(np.argmax(s10))
    hl10 = half_life(s10, float(np.median(y)), pk10) / 6.0
    hl_mass = float("nan")
    if main is not None:
        tpk = t10[0] + int(np.argmax(y)) * 600 + 300
        tend = H0 + 3600 * (first_idx + main["end"] + 2)
        dl = t10[(t10 > tpk) & (t10 < tend)] - tpk
        if len(dl) >= 4: hl_mass = float(np.median(dl)) / 3600.0
    st = dict(meme=m, display_name=c["display_name"], display_symbol=c["display_symbol"], cls=cls,
              launches=int(c["launches"]), distinct_launchers=int(c["distinct_launchers"]),
              top_launcher_share=float(c["top_launcher_share"]), prolific_share=float(c["prolific_share"]),
              first_hour_ts=int(H0 + 3600 * first_idx), observed_h=L, active_hours=int(c["active_hours"]),
              left_censored=bool(first_idx < EDGE_H), peak_right_censored=bool(pk >= L - EDGE_H),
              baseline=b, time_to_peak_h=pk, peak_hour_ts=int(H0 + 3600 * (first_idx + pk)),
              peak_height=float(x.max()), peak_s=float(s[pk]), peak_share_of_launches=float(x.max() / x.sum()),
              half_life_h=hl, half_life_fit_h=hl_fit,
              half_life_10min_h=hl10, half_life_mass_h=hl_mass, time_to_peak_10min_h=pk10 / 6.0, peak_10min_launches=float(y.max()), n_bursts=len(bs),
              first_hour_launches=float(x[0]),
              main_burst_dur_h=float(main["dur_h"]) if main else float("nan"),
              main_rise_h=float(main["rise_h"]) if main else float("nan"),
              main_onset_jump=float(main["jump"]) if main else float("nan"),
              main_onset_jump_frac=float(main["jump_frac"]) if main else float("nan"),
              total_buyers_hours=float(buyers.sum()), sol_volume=float(vol.sum()),
              buyers_peak=float(buyers.max()), buyers_time_to_peak_h=bpk,
              buyers_half_life_h=half_life(sb, bb, bpk) if buyers.max() > 0 else float("nan"),
              buyers_peak_minus_launch_peak_h=bpk - pk, corr_launches_buyers=corr)
    stats.append(st)
    for i, q in enumerate(bs):
        burst_rows.append(dict(meme=m, cls=cls, burst_no=i, **q,
                               gap_from_prev_start_h=(q["start"] - bs[i - 1]["start"]) if i else None,
                               peak_ratio_to_first=q["peak_s"] / bs[0]["peak_s"]))

def to_parquet(rowdicts, path):
    cols = list(rowdicts[0].keys())
    con.execute("drop table if exists t")
    def typ(k):
        v = next((r[k] for r in rowdicts if r[k] is not None), 0)
        return "varchar" if isinstance(v, str) else "boolean" if isinstance(v, bool) else "bigint" if isinstance(v, int) else "double"
    con.execute("create table t (" + ", ".join(f'"{k}" {typ(k)}' for k in cols) + ")")
    con.executemany("insert into t values (" + ",".join("?" * len(cols)) + ")",
                    [[None if isinstance(r[k], float) and math.isnan(r[k]) else r[k] for k in cols] for r in rowdicts])
    con.execute(f"copy t to '{path}' (format parquet)")

to_parquet(stats, f"{OUT}/meme_shape_stats.parquet")
to_parquet(burst_rows, f"{OUT}/meme_bursts.parquet")

def q(vals):
    v = np.array([z for z in vals if z is not None and not (isinstance(z, float) and math.isnan(z))], dtype=float)
    if len(v) == 0: return dict(n=0)
    d = dict(n=int(len(v)), mean=round(float(v.mean()), 3))
    for p, z in zip(QS, np.quantile(v, QS)): d[f"q{int(p*100):02d}"] = round(float(z), 3)
    return d

def summarise(S, B):
    born = [r for r in S if not r["left_censored"]]
    core = [r for r in born if not r["peak_right_censored"] and r["n_bursts"] > 0]
    nb = np.array([r["n_bursts"] for r in born])
    multi = [r for r in B if r["burst_no"] > 0]
    return dict(
        n_memes=len(S), n_born_in_window=len(born), n_core=len(core),
        note="core = first launch after the first 24 h, peak before the last 24 h, at least one burst",
        launches_total=q([r["launches"] for r in S]),
        time_to_peak_h=q([r["time_to_peak_h"] for r in core]),
        peak_height_launches_per_h=q([r["peak_height"] for r in core]),
        peak_s_launches_per_h=q([r["peak_s"] for r in core]),
        peak_share_of_launches=q([r["peak_share_of_launches"] for r in core]),
        half_life_h=q([r["half_life_h"] for r in core]),
        half_life_censored_frac=round(float(np.mean([math.isnan(r["half_life_h"]) for r in core])), 4) if core else None,
        half_life_fit_h=q([r["half_life_fit_h"] for r in core]),
        half_life_10min_h=q([r["half_life_10min_h"] for r in core]),
        half_life_mass_h=q([r["half_life_mass_h"] for r in core]),
        time_to_peak_10min_h=q([r["time_to_peak_10min_h"] for r in core]),
        peak_10min_launches=q([r["peak_10min_launches"] for r in core]),
        main_burst_dur_h=q([r["main_burst_dur_h"] for r in core]),
        main_rise_h=q([r["main_rise_h"] for r in core]),
        onset_jump_launches_per_h=q([r["main_onset_jump"] for r in core]),
        onset_jump_frac_of_peak=q([r["main_onset_jump_frac"] for r in core]),
        first_hour_launches=q([r["first_hour_launches"] for r in born]),
        n_bursts=q(nb),
        n_bursts_pmf={str(k): round(float((nb == k).mean()), 4) for k in range(0, 6)} | {"6+": round(float((nb >= 6).mean()), 4)} if len(nb) else {},
        bursts_per_100h_observed=q([100.0 * r["n_bursts"] / r["observed_h"] for r in born]),
        reignition_gap_h=q([r["gap_from_prev_start_h"] for r in multi]),
        reignition_peak_ratio_to_first=q([r["peak_ratio_to_first"] for r in multi]),
        all_bursts_onset_jump=q([r["jump"] for r in B]),
        all_bursts_dur_h=q([r["dur_h"] for r in B]),
        buyers_peak_per_h=q([r["buyers_peak"] for r in core]),
        buyers_half_life_h=q([r["buyers_half_life_h"] for r in core]),
        buyers_peak_minus_launch_peak_h=q([r["buyers_peak_minus_launch_peak_h"] for r in core]),
        corr_launches_buyers_hourly=q([r["corr_launches_buyers"] for r in core]),
        sol_volume_total=q([r["sol_volume"] for r in core]),
    )

groups = {}
for g in ["episodic", "evergreen", "single_actor"]:
    S = [r for r in stats if r["cls"] == g]; B = [r for r in burst_rows if r["cls"] == g]
    if S: groups[g] = summarise(S, B)
ev = [dict(r, left_censored=False) for r in stats if r["cls"] == "evergreen"]
groups["evergreen"] = summarise(ev, [r for r in burst_rows if r["cls"] == "evergreen"])
groups["evergreen"]["note"] = "evergreen names were all present from the start of the window, so the left-censoring filter is waived; time_to_peak is measured from the window start and is not a real time-to-peak"
big = [r for r in stats if r["cls"] == "episodic" and r["launches"] >= 100]
groups["episodic_100plus"] = summarise(big, [r for r in burst_rows if r["meme"] in {z["meme"] for z in big}])

# ---- new-meme arrival rate -------------------------------------------------------------------
lo, hi = H0 + BURN_IN_H * 3600, H0 + (NH - RUNWAY_H) * 3600
sa = {r["meme"] for r in stats if r["cls"] == "single_actor"}
tiers = {
    "any_new_name": lambda c: True,
    "ge5_launches_in_72h": lambda c: c["launches_72h"] >= 5,
    "ge20_launches_in_72h": lambda c: c["launches_72h"] >= 20,
    "ge20_in_72h_not_single_actor": lambda c: c["launches_72h"] >= 20 and c["meme"] not in sa and c["top_launcher_share"] < 0.5 and c["distinct_launchers"] >= 5,
    "ge100_launches_in_72h": lambda c: c["launches_72h"] >= 100,
}
nh_arr = (hi - lo) // 3600
arrival = dict(note=f"a meme is 'new' at its first launch; names first seen in the first {BURN_IN_H} h are treated as pre-existing, "
                    f"and births in the last {RUNWAY_H} h are dropped so every birth has 72 h to reach the size tier. Hours are UTC.",
               hours_counted=int(nh_arr), tiers={})
for name, f in tiers.items():
    cnt = np.zeros(nh_arr)
    for c in clusters:
        if lo <= c["first_ts"] < hi and f(c):
            cnt[(c["first_ts"] - lo) // 3600] += 1
    hod = np.array([(lo // 3600 + i) % 24 for i in range(nh_arr)])
    by = [float(cnt[hod == h].mean()) for h in range(24)]
    arrival["tiers"][name] = dict(per_hour_mean=round(float(cnt.mean()), 4), per_day_mean=round(float(cnt.mean() * 24), 2),
                                  per_hour_var=round(float(cnt.var()), 4),
                                  dispersion_var_over_mean=round(float(cnt.var() / cnt.mean()), 3) if cnt.mean() > 0 else None,
                                  per_hour_quantiles={f"q{int(p*100):02d}": float(z) for p, z in zip(QS, np.quantile(cnt, QS))},
                                  by_utc_hour=[round(z, 4) for z in by],
                                  utc_hour_multiplier=[round(z / cnt.mean(), 3) if cnt.mean() > 0 else None for z in by])

iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()
params = dict(
    generated_by="packages/simulation/src/learned_markets_simulation/calibration/attention/fit_shapes.py",
    source="pump_creates/pump_trades parquet, epochs 1074-1089",
    window=dict(start_ts=int(W0), end_ts=int(W1), start=iso(W0), end=iso(W1), hours=int(NH)),
    clustering_rule="meme key = lower(name) with all non letter/digit characters removed, then one leading the/official and one "
                    "trailing coin/token/onsolana/onsol/official stripped (only if >=3 chars remain); symbol used when the name is empty",
    min_launches=20, quantile_levels=QS,
    counts=dict(clusters_all=len(clusters), memes_ge20=len(stats),
                **{g: sum(r["cls"] == g for r in stats) for g in ["episodic", "evergreen", "single_actor"]}),
    units="time in hours, heights in launches per hour (hourly bins, 3 h smoothing for peak/half-life/bursts)",
    shape_stats=groups, new_meme_arrivals=arrival)
_pj = os.path.join(OUT, "attention_params.json")
if os.path.exists(_pj):  # keep sections written by buyers_decay.py
    params.update({k: v for k, v in json.load(open(_pj)).items() if k.startswith("buyers")})
json.dump(params, open(_pj, "w"), indent=1)

# ---- summary.md -------------------------------------------------------------------------------
def table(g, keys):
    lines = ["| statistic | n | mean | " + " | ".join(f"q{int(p*100):02d}" for p in QS) + " |", "|---|---|---|" + "---|" * len(QS)]
    for k in keys:
        d = groups[g][k]
        if d.get("n", 0) == 0: continue
        lines.append(f"| {k} | {d['n']} | {d['mean']} | " + " | ".join(str(d[f"q{int(p*100):02d}"]) for p in QS) + " |")
    return "\n".join(lines)
KEYS = ["launches_total", "time_to_peak_h", "peak_height_launches_per_h", "peak_s_launches_per_h", "peak_share_of_launches",
        "half_life_h", "half_life_fit_h", "half_life_10min_h", "half_life_mass_h", "time_to_peak_10min_h", "peak_10min_launches", "main_burst_dur_h", "main_rise_h", "onset_jump_launches_per_h", "onset_jump_frac_of_peak",
        "first_hour_launches", "n_bursts", "bursts_per_100h_observed", "reignition_gap_h", "reignition_peak_ratio_to_first",
        "buyers_peak_per_h", "buyers_half_life_h", "buyers_peak_minus_launch_peak_h", "corr_launches_buyers_hourly", "sol_volume_total"]
md = [f"# Attention calibration from pump.fun launch counts", "",
      f"Generated by `fit_shapes.py`. Window {iso(W0)} to {iso(W1)} ({NH} hourly bins, epochs 1074-1089).", "",
      f"Clustering rule: {params['clustering_rule']}.", "",
      f"Clusters: {len(clusters)} names in total, {len(stats)} with >= 20 launches: "
      f"{params['counts']['episodic']} episodic, {params['counts']['evergreen']} evergreen, {params['counts']['single_actor']} single-actor (excluded).", "",
      "Definitions of every statistic and class are in the docstring of `fit_shapes.py`.", ""]
for g, title in [("episodic", "Episodic memes (main calibration set)"), ("episodic_100plus", "Episodic memes with >= 100 launches"), ("evergreen", "Evergreen names")]:
    if g not in groups: continue
    G = groups[g]
    md += [f"## {title}", "", f"{G['n_memes']} memes, " + ("" if g == "evergreen" else f"{G['n_born_in_window']} first launched after the first 24 h, ") + f"{G['n_core']} in the core set "
           f"({G['note']}). Half-life censored (never fell to half inside the window) for {G['half_life_censored_frac']} of the core set.", "",
           table(g, KEYS), "", "Number of bursts per meme (share of memes born in window): " +
           ", ".join(f"{k}: {v}" for k, v in G["n_bursts_pmf"].items()), ""]
md += ["## New-meme arrivals", "", arrival["note"], "", "| tier | per hour | per day | var/mean of hourly count |", "|---|---|---|---|"]
for k, d in arrival["tiers"].items():
    md.append(f"| {k} | {d['per_hour_mean']} | {d['per_day_mean']} | {d['dispersion_var_over_mean']} |")
md += ["", "Multiplier on the mean rate by UTC hour of day (0..23):", ""]
for k in ["any_new_name", "ge5_launches_in_72h", "ge20_launches_in_72h"]:
    md.append(f"- {k}: " + ", ".join(str(z) for z in arrival["tiers"][k]["utc_hour_multiplier"]))
md += ["", "## Caveats", "",
 "- Launching is mostly automated: wallets with >= 50 launches in the window make about 62% of all launches, and most clusters get more than half of their launches from such wallets. The series measures how hard launch bots chase a name, which is a proxy for attention, not attention itself.",
 "- 78 evergreen names (moonfrog, greencat, alienshibainux, ...) are relaunched around the clock by roughly 500-700 wallets each at near-identical volumes. They look like a fixed name list worked by a wallet farm; they are kept as a separate class and should not drive rise/decay calibration.",
 "- 1398 clusters are single-actor spam (one wallet >= 50% of launches, e.g. laughingmonkey: 2855 launches from 12 wallets) and are excluded from every table.",
 "- Hourly bins are too coarse for the decay. half_life_h and half_life_10min_h sit at the floor set by their own smoothing (about 1.5 bins). half_life_mass_h has no smoothing and is the one to use: launch bursts mostly die within minutes, with a heavy tail of hours to days. buyers_half_life_h is hourly and has the same floor.",
 "- time_to_peak_h is bimodal: about a third of memes peak in their first hour (the burst is the birth), the rest peak days later on a re-ignition. It is bounded by the 17-day window, as are reignition gaps.",
 "- Name clustering under-merges narratives (gta6, gta, grandtheftautovi, rockstargames, lucia are separate memes; so are jensen, jensenhuang, jensenhung) and over-merges generic words (sol, coin, test, inu, 1).",
 "- Only 17 days (2026-11-01 to 2026-11-18). Names seen in the first 24 h are treated as pre-existing; the first and last hourly bins are partial.",
 "- Trades: sol_volume sums sol_amount of buys and sells on the bonding curve only (no PumpSwap volume after migration); non-SOL curves report 0. distinct_buyers is per hour and not deduplicated across hours.",
 "- peak heights are in launches per hour and depend on the >= 20 launches cut-off; the simulator should treat them as relative scales.", ""]
_sm = os.path.join(OUT, "summary.md")
if os.path.exists(_sm):  # keep sections written by buyers_decay.py
    import re
    md += re.findall(r"<!-- BUYERS[^>]*START -->.*?<!-- BUYERS[^>]*END -->", open(_sm).read(), flags=re.S)
open(_sm, "w").write("\n".join(md) + "\n")
print("\n".join(md))
