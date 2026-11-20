import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'

export type Series = { name: string; color: string; values: number[]; dashed?: boolean; area?: boolean }

const nice = (v: number) => {
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

function ticks(lo: number, hi: number, n = 4) {
  const span = hi - lo || 1
  const step0 = span / n
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10))
  return out
}

/**
 * Responsive SVG line chart: one y-axis, recessive grid, end labels, crosshair
 * tooltip listing every series, animated draw-in when scrolled into view.
 */
export function LineChart({
  x,
  series,
  height = 240,
  unit = '',
  xUnit = 'min',
  bands = [],
  yMin,
  compact = false,
  format = nice,
}: {
  x: number[]
  series: Series[]
  height?: number
  unit?: string
  xUnit?: string
  bands?: { from: number; to: number; label: string; tone: 'buy' | 'sell' }[]
  yMin?: number
  compact?: boolean
  format?: (v: number) => string
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [seen, setSeen] = useState(false)
  const id = useId().replaceAll(':', '')
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold: 0.25 })
    io.observe(el)
    return () => {
      ro.disconnect()
      io.disconnect()
    }
  }, [])
  const pad = { l: compact ? 48 : 52, r: compact ? 12 : 92, t: 12, b: 26 }
  const all = series.flatMap((s) => s.values)
  let lo = yMin ?? Math.min(...all)
  let hi = Math.max(...all)
  if (hi === lo) hi = lo + 1
  const yt = ticks(lo, hi)
  lo = Math.min(lo, yt[0])
  hi = Math.max(hi, yt[yt.length - 1])
  const x0 = x[0]
  const x1 = x[x.length - 1] || 1
  const X = (v: number) => pad.l + ((v - x0) / (x1 - x0 || 1)) * (w - pad.l - pad.r)
  const Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b)
  const path = (vals: number[]) => vals.map((v, i) => (i ? 'L' : 'M') + X(x[i]).toFixed(1) + ' ' + Y(v).toFixed(1)).join('')
  const xt = ticks(x0, x1, compact ? 4 : 5)
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left
    const v = x0 + ((px - pad.l) / (w - pad.l - pad.r)) * (x1 - x0)
    let best = 0
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - v) < Math.abs(x[best] - v)) best = i
    setHover(best)
  }
  // End labels, nudged apart so they never collide.
  const ends = series
    .map((s) => ({ s, y: Y(s.values[s.values.length - 1]) }))
    .sort((a, b) => a.y - b.y)
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14
  return (
    <div className={'lchart' + (seen ? ' seen' : '')} ref={wrap}>
      {w > 0 && <svg width={w} height={height} onPointerMove={move} onPointerLeave={() => setHover(null)} role="img">
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={id + i} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity="0.14" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {bands.map((b) => (
          <g key={b.label}>
            <rect
              x={X(b.from)}
              y={pad.t}
              width={Math.max(0, X(b.to) - X(b.from))}
              height={height - pad.t - pad.b}
              className={'lband ' + b.tone}
            />
            <text x={X(b.from) + 6} y={pad.t + 14 + (b.tone === 'sell' ? 16 : 0)} className="lband-label">
              {b.label}
            </text>
          </g>
        ))}
        {yt.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={Y(t)} y2={Y(t)} className="lgrid" />
            <text x={pad.l - 8} y={Y(t) + 4} className="laxis" textAnchor="end">
              {format(t)}
              {unit}
            </text>
          </g>
        ))}
        {xt.map((t) => (
          <text key={t} x={X(t)} y={height - 6} className="laxis" textAnchor="middle">
            {Math.round(t)}
            {xUnit}
          </text>
        ))}
        {series.map((s, i) =>
          s.area ? (
            <path
              key={'a' + i}
              d={path(s.values) + `L${X(x1)} ${Y(lo)}L${X(x0)} ${Y(lo)}Z`}
              fill={`url(#${id + i})`}
              className="larea"
            />
          ) : null,
        )}
        {series.map((s, i) => (
          <path
            key={i}
            d={path(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.dashed ? 1.5 : 2}
            strokeDasharray={s.dashed ? '4 4' : undefined}
            className={s.dashed ? 'lline dashed' : 'lline'}
            pathLength={s.dashed ? undefined : 1}
          />
        ))}
        {!compact &&
          ends.map(({ s, y }) => (
            <text key={s.name} x={w - pad.r + 8} y={y + 4} className="lend">
              {s.name}
            </text>
          ))}
        {hover !== null && (
          <g>
            <line x1={X(x[hover])} x2={X(x[hover])} y1={pad.t} y2={height - pad.b} className="lcross" />
            {series.map((s) => (
              <circle key={s.name} cx={X(x[hover])} cy={Y(s.values[hover])} r={4} fill={s.color} stroke="#0d0b18" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>}
      {hover !== null && (
        <div className="ltip" style={{ left: Math.min(X(x[hover]) + 12, w - 170) }}>
          <small>
            {x[hover].toFixed(1)} {xUnit}
          </small>
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              <b>
                {format(s.values[hover])}
                {unit}
              </b>
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
