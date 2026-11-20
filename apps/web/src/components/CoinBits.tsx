import type { CSSProperties, ReactNode } from 'react'

const GRADIENTS = [
  ['#ff3d81', '#7b2ff7'],
  ['#00e1ff', '#5b3cff'],
  ['#ffb800', '#ff3d6e'],
  ['#21e6a1', '#0b84ff'],
  ['#ff6a00', '#ee0979'],
  ['#c471f5', '#fa71cd'],
  ['#f9d423', '#ff4e50'],
  ['#43e97b', '#38f9d7'],
]

export function gradientFor(seed: string) {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const [a, b] = GRADIENTS[h % GRADIENTS.length]
  return `linear-gradient(135deg, ${a}, ${b})`
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
        fontSize: fontSize ?? Math.max(10, Math.round(size / 5)),
        ...style,
      }}
    >
      {image ? <img src={image} alt="" draggable={false} loading="lazy" /> : <span>{ticker.slice(0, 4)}</span>}
      {children}
    </div>
  )
}
