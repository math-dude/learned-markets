import type { CSSProperties } from 'react'

const fmt = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(Math.round(n))

/**
 * One batch, animated: buys rush in from the left and sells from the right, the
 * overlapping amount collides at the clearing line and cancels out, and the
 * maker steps in for whatever net imbalance is left.
 */
export function BatchClash({
  buys,
  sells,
  batch,
  compact = false,
  label,
}: {
  buys: number
  sells: number
  batch: number | string | undefined
  compact?: boolean
  label?: string
}) {
  const matched = Math.min(buys, sells)
  const scale = Math.max(1, buys, sells)
  // Halves are 50% wide, so their children use half-relative widths; the maker spans the whole track.
  const pct = (v: number) => (v / scale) * 96 + '%'
  const net = Math.abs(buys - sells)
  const makerSells = buys > sells
  const vars = {
    '--buy-rest': pct(buys - matched),
    '--sell-rest': pct(sells - matched),
    '--match': pct(matched),
    '--maker': (net / scale) * 48 + '%',
  } as CSSProperties
  return (
    <div className={'clash' + (compact ? ' clash-compact' : '')} style={vars}>
      {!compact && (
        <div className="clash-head">
          <span className="clash-side buy">
            <b>{fmt(buys)}</b> bought
          </span>
          <span className="clash-title">{label ?? (batch !== undefined ? 'Batch #' + batch : 'Waiting for a batch')}</span>
          <span className="clash-side sell">
            sold <b>{fmt(sells)}</b>
          </span>
        </div>
      )}
      <div className="clash-track" key={String(batch)}>
        <div className="clash-half clash-left">
          <i className="clash-rest buy" />
          <i className="clash-match buy" />
        </div>
        <div className="clash-half clash-right">
          <i className="clash-match sell" />
          <i className="clash-rest sell" />
        </div>
        {net > 0 && <i className={'clash-maker ' + (makerSells ? 'right' : 'left')} />}
        <span className="clash-spark" />
        <span className="clash-line" />
      </div>
      {!compact && (
        <div className="clash-foot" key={'f' + String(batch)}>
          <span className="clash-pill match">
            <i /> {fmt(matched)} cancelled out
          </span>
          <span className="clash-pill maker">
            <i /> maker {makerSells ? 'sold' : 'bought'} {fmt(net)}
          </span>
        </div>
      )}
    </div>
  )
}
