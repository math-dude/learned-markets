import { useId, useState, type PointerEvent } from 'react'
import { num, signedPct } from '../../lib/format'
export interface Candle {
  o: number
  h: number
  l: number
  c: number
  v: number
}

export function CandleChart({
  candles,
  price,
  ticker,
  unit,
  caption,
}: {
  candles: Candle[]
  price: number
  ticker: string
  unit: 'SOL' | 'lamports'
  caption: (index: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [mode, setMode] = useState<'Price' | 'Candles'>('Candles')
  const [range, setRange] = useState(60)
  const gradient = useId().replaceAll(':', '')
  const offset = Math.max(0, candles.length - range)
  const data = candles.slice(offset)
  if (!data.length)
    return (
      <section className="card">
        <h2>Price history</h2>
        <p>The chart starts with the first confirmed fill.</p>
      </section>
    )
  const low = Math.min(price, ...data.map((c) => c.l))
  const high = Math.max(price, ...data.map((c) => c.h))
  const padding = Math.max((high - low) * 0.18, high * 0.002, 0.000001)
  const top = high + padding
  const bottom = Math.max(0, low - padding)
  // Price occupies its own plot. Volume has a separate lane underneath.
  const y = (value: number) => 24 + ((top - value) / (top - bottom)) * 230
  const x = (i: number) => 24 + ((i + 0.5) / data.length) * 856
  const volume = Math.max(1, ...data.map((c) => c.v))
  const index = hover === null ? data.length - 1 : Math.min(hover, data.length - 1)
  const selected = data[index]
  const change = (price / data[0].o - 1) * 100
  const color = change >= 0 ? 'var(--green)' : 'var(--red)'
  const points = data.map((c, i) => x(i) + ',' + y(c.c)).join(' ')
  const digits = unit === 'SOL' ? 7 : 5
  const display = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: digits })
  function move(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const position = (((event.clientX - rect.left) / rect.width) * 1000 - 24) / 856
    setHover(Math.max(0, Math.min(data.length - 1, Math.floor(position * data.length))))
  }
  return (
    <section className="market-chart" aria-label="Price chart">
      <header className="market-chart-head">
        <div>
          <small>
            {ticker} / {unit === 'SOL' ? 'SOL' : 'lamports'}
          </small>
          <strong key={price} className="chart-live-price">
            {display(price)} <span style={{ color }}>{signedPct(change, 2)}</span>
          </strong>
        </div>
        <div className="paper-tabs">
          {(['Price', 'Candles'] as const).map((value) => (
            <button
              key={value}
              className="pill-btn"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </header>
      <div className="chart-toolbar">
        <span>{caption(offset + index)}</span>
        <div>
          {[20, 60, 240].map((value) => (
            <button
              className="chart-range"
              aria-pressed={range === value}
              key={value}
              onClick={() => {
                setRange(value)
                setHover(null)
              }}
            >
              {value} batches
            </button>
          ))}
        </div>
      </div>
      <div className="chart-ohlc">
        <span>
          O <b>{display(selected.o)}</b>
        </span>
        <span>
          H <b>{display(selected.h)}</b>
        </span>
        <span>
          L <b>{display(selected.l)}</b>
        </span>
        <span>
          C <b>{display(selected.c)}</b>
        </span>
      </div>
      <svg
        preserveAspectRatio="none"
        className="price-canvas"
        viewBox="0 0 1000 350"
        role="img"
        aria-label={ticker + ' confirmed price history. ' + data.length + ' batches.'}
        onPointerMove={move}
        onPointerDown={move}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity=".2" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line
              x1="20"
              x2="888"
              y1={24 + t * 230}
              y2={24 + t * 230}
              stroke="var(--border-soft)"
              strokeDasharray="3 6"
            />
            <text x="906" y={28 + t * 230} className="chart-axis">
              {display(top - t * (top - bottom))}
            </text>
          </g>
        ))}
        {mode === 'Price' ? (
          <g className="chart-series">
            <polygon
              points={x(0) + ',270 ' + points + ' ' + x(data.length - 1) + ',270'}
              fill={'url(#' + gradient + ')'}
            />
            <polyline
              points={points}
              fill="none"
              stroke={color}
              strokeWidth="2.5"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={x(data.length - 1)}
              cy={y(data.at(-1)!.c)}
              r="4"
              fill={color}
              className="chart-last-dot"
            />
          </g>
        ) : (
          data.map((c, i) => {
            const up = c.c >= c.o
            const fill = up ? 'var(--green)' : 'var(--red)'
            const width = Math.min(24, (856 / data.length) * 0.65)
            return (
              <g key={offset + i}>
                <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={fill} />
                <rect
                  x={x(i) - width / 2}
                  y={y(Math.max(c.o, c.c))}
                  width={width}
                  height={Math.max(2, Math.abs(y(c.o) - y(c.c)))}
                  fill={fill}
                  rx="1"
                />
              </g>
            )
          })
        )}
        <line x1="20" x2="888" y1="280" y2="280" stroke="var(--border-soft)" />
        {data.map((c, i) => (
          <rect
            key={offset + i}
            x={x(i) - Math.min(24, (856 / data.length) * 0.65) / 2}
            y={328 - (c.v / volume) * 32}
            width={Math.min(24, (856 / data.length) * 0.65)}
            height={(c.v / volume) * 32}
            fill={c.c >= c.o ? 'var(--green)' : 'var(--red)'}
            opacity=".35"
          />
        ))}
        <text x="906" y="307" className="chart-axis">
          VOLUME
        </text>
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={x(index)} x2={x(index)} y1="20" y2="330" stroke="var(--muted)" strokeDasharray="4 4" />
            <circle cx={x(index)} cy={y(selected.c)} r="5" fill="var(--bg)" stroke={color} strokeWidth="2" />
          </g>
        )}
      </svg>
      <footer className="chart-footer">
        <span>{caption(offset)}</span>
        <span>{hover === null ? 'Confirmed batches' : num(selected.v) + ' tokens traded'}</span>
        <span>{caption(offset + data.length - 1)}</span>
      </footer>
    </section>
  )
}
