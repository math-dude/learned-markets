import { useState, type PointerEvent } from 'react'
import { num, signedPct } from '../../lib/format'
export interface Candle { o: number; h: number; l: number; c: number; v: number }

/** Plot area insets inside the chart box (right side holds price tags). */
const LEFT = 8
const RIGHT = 84

export function CandleChart({ candles, price, ticker, unit, caption }: {
  candles: Candle[]; price: number; ticker: string; unit: 'SOL' | 'lamports'
  caption: (index: number) => string
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  if (!candles.length) return <section className="card"><h2>Price history</h2><p>The chart starts with the first fill.</p></section>
  const agg = [...candles]
  // The live price may have moved since the last round (other traders); show it on the last candle.
  const lastK = { ...agg[agg.length - 1] }
  lastK.c = price
  lastK.h = Math.max(lastK.h, price)
  lastK.l = Math.min(lastK.l, price)
  agg[agg.length - 1] = lastK

  const lo = Math.min(...agg.map((k) => k.l))
  const hi = Math.max(...agg.map((k) => k.h))
  const pad = (hi - lo) * 0.12 || 0.0001
  const top = hi + pad
  const bot = lo - pad * 2.2
  const yp = (v: number) => ((top - v) / (top - bot)) * 100
  const vmax = Math.max(1, ...agg.map((k) => k.v))
  const n = agg.length

  const hIdx = hoverIdx === null ? null : Math.min(n - 1, hoverIdx)
  const hk = hIdx === null ? null : agg[hIdx]
  const xAt = (i: number) => `calc(${LEFT}px + (100% - ${LEFT + RIGHT}px) * ${((i + 0.5) / n).toFixed(4)})`
  const up = (k: Candle) => k.c >= k.o
  const tagColor = up(lastK) ? 'var(--green)' : 'var(--red)'

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)))
    if (i !== hoverIdx) setHoverIdx(i)
  }

  return (
    <section aria-label="Price chart" style={{ padding: '14px 20px 6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 16 }}>Price · {unit} per token</span>
      </div>
      <div className="chart">
        {[25, 50, 75].map((p) => (
          <div key={p} aria-hidden="true" className="chart-grid" style={{ top: `${p}%` }} />
        ))}
        <div
          role="img"
          aria-label={`${ticker} price candles. Drag across to see the price at any point.`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHoverIdx(null)}
          style={{ position: 'absolute', left: LEFT, right: RIGHT, top: 0, bottom: 0, cursor: 'crosshair', touchAction: 'none' }}
        >
          {agg.map((k, i) => {
            const color = up(k) ? 'var(--green)' : 'var(--red)'
            return (
              <div key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${((i / n) * 100).toFixed(3)}%`, width: `${(100 / n).toFixed(3)}%` }}>
                <div style={{ position: 'absolute', left: '50%', width: 1, marginLeft: -0.5, top: `${yp(k.h).toFixed(2)}%`, height: `${Math.max(0.3, yp(k.l) - yp(k.h)).toFixed(2)}%`, background: color }} />
                <div style={{ position: 'absolute', left: '15%', right: '15%', top: `${yp(Math.max(k.o, k.c)).toFixed(2)}%`, height: `${Math.max(0.4, Math.abs(yp(k.o) - yp(k.c))).toFixed(2)}%`, minHeight: 1, background: color, borderRadius: 1 }} />
                <div style={{ position: 'absolute', left: '15%', right: '15%', bottom: 0, height: `${((k.v / vmax) * 14).toFixed(2)}%`, background: color, opacity: 0.25 }} />
              </div>
            )
          })}
        </div>
        {hk && hIdx !== null && (
          <>
            <div aria-hidden="true" className="crosshair-v" style={{ left: xAt(hIdx) }} />
            <div aria-hidden="true" className="crosshair-h" style={{ top: `${yp(hk.c).toFixed(2)}%` }} />
            <span className="price-tag tnum" style={{ top: `${yp(hk.c).toFixed(2)}%`, background: '#3F3F46', color: 'var(--text)', zIndex: 2 }}>
              {hk.c.toFixed(5)}
            </span>
            <div role="status" className="chart-tip tnum" style={{ left: hIdx > n * 0.6 ? `calc(${xAt(hIdx)} - 232px)` : `calc(${xAt(hIdx)} + 12px)` }}>
              <span className="muted">{caption(hIdx)}</span>
              <TipRow label="Open" value={hk.o.toFixed(5)} />
              <TipRow label="High" value={hk.h.toFixed(5)} />
              <TipRow label="Low" value={hk.l.toFixed(5)} />
              <span className="kv">
                <span className="muted">Close</span>
                <span style={{ fontWeight: 700, color: up(hk) ? 'var(--green)' : 'var(--red)' }}>
                  {hk.c.toFixed(5)} <span style={{ fontWeight: 400 }}>{signedPct((hk.c / hk.o - 1) * 100, 2)}</span>
                </span>
              </span>
              <span className="kv" style={{ paddingTop: 5, borderTop: '1px solid var(--chip)' }}>
                <span className="muted">vs now</span>
                <span style={{ fontWeight: 600, color: price >= hk.c ? 'var(--green)' : 'var(--red)' }}>{signedPct((price / hk.c - 1) * 100, 2)}</span>
              </span>
              <TipRow label="1 SOL bought" value={`${num((unit === 'SOL' ? 1 : 1e9) / hk.c)} ${ticker}`} />
            </div>
          </>
        )}
        <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: `${yp(price).toFixed(1)}%`, borderTop: `1px dashed ${tagColor}`, opacity: 0.5, transition: 'top 0.6s ease' }} />
        <span className="price-tag tnum" style={{ top: `${yp(price).toFixed(1)}%`, background: tagColor, color: 'var(--bg)', transition: 'top 0.6s ease' }}>
          {price.toFixed(5)}
        </span>
        <span className="axis-label tnum" style={{ top: 8 }}>
          {top.toFixed(5)}
        </span>
        <span className="axis-label tnum" style={{ bottom: 8 }}>
          {bot.toFixed(5)}
        </span>
      </div>
    </section>
  )
}

function TipRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="kv">
      <span className="muted">{label}</span>
      <span>{value}</span>
    </span>
  )
}
