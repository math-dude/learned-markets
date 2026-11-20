import type { CSSProperties, ReactNode } from 'react'

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
