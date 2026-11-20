import type { CSSProperties, ReactNode } from 'react'

const TINTS = ['#2C2528', '#26262B', '#2D2A24', '#26282E', '#2B2925', '#23272B', '#25282C']

export function gradientFor(seed: string) {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return TINTS[h % TINTS.length]
}

export function CoinTile({
  tint,
  ticker,
  size = 72,
  fontSize,
  style,
  image,
  children,
}: {
  tint?: string
  ticker: string
  size?: number
  fontSize?: number
  style?: CSSProperties
  image?: string | null
  children?: ReactNode
}) {
  void tint
  return (
    <div
      aria-hidden="true"
      className="tile coin-orb"
      style={{
        width: size,
        height: size,
        background: gradientFor(ticker),
        fontSize: fontSize ?? (size >= 64 ? 15 : size >= 40 ? 12 : 10),
        ...style,
      }}
    >
      {image ? <img src={image} alt="" draggable={false} loading="lazy" /> : <span>{ticker.slice(0, 4)}</span>}
      {children}
    </div>
  )
}
