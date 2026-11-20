import type { CSSProperties, ReactNode } from 'react'
import { STATUS_COLORS } from '../market/seed'
import type { MakerStatus } from '../market/types'
import { UpArrowIcon } from './icons'

export function CoinTile({
  tint,
  ticker,
  size = 72,
  fontSize,
  style,
  children,
}: {
  tint: string
  ticker: string
  size?: number
  fontSize?: number
  style?: CSSProperties
  children?: ReactNode
}) {
  return (
    <div
      aria-hidden="true"
      className="tile"
      style={{ width: size, height: size, background: tint, fontSize: fontSize ?? (size >= 64 ? 15 : 12), ...style }}
    >
      {ticker}
      {children}
    </div>
  )
}

export function StatusBadge({ status, small }: { status: MakerStatus; small?: boolean }) {
  return (
    <span className="badge badge-outline" style={{ color: STATUS_COLORS[status], fontSize: small ? 11 : 12 }}>
      {status}
    </span>
  )
}

export function RookieBadge({ compact }: { compact?: boolean }) {
  return (
    <span className="badge badge-rookie" style={compact ? { padding: '1px 7px', fontSize: 11, background: 'transparent' } : undefined}>
      {!compact && <UpArrowIcon />}
      ROOKIE
    </span>
  )
}
