import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'
import type { ChainState } from '../wallet/ChainMarket'

type Item =
  | { id: string; kind: 'launch'; address: string; ticker: string; name: string; image?: string | null; at: number }
  | { id: string; kind: 'death'; address: string; ticker: string; total: number; to: { ticker: string; address: string; amount: number }[]; deployers: number; platform: number; image?: string | null; at: number }
  | { id: string; kind: 'trade'; address: string; ticker: string; side: string; qty: number; who?: string; image?: string | null; at: number }

const sol = (lamports: number) =>
  (lamports / 1e9).toLocaleString('en-US', { maximumFractionDigits: lamports < 1e7 ? 5 : 3 })
const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n))

export function LiveFeed({ state }: { state: ChainState }) {
  const [items, setItems] = useState<Item[]>([])
  const seen = useRef(new Set<string>())
  const images = useRef(new Map<string, { ticker: string; image?: string | null }>())
  const first = useRef(true)

  useEffect(() => {
    for (const m of state.markets) images.current.set(m.address, { ticker: m.ticker, image: m.image })
    const fresh: Item[] = []
    const now = Date.now()
    const live = state.markets.filter((m) => m.live)
    for (const m of first.current ? live.slice(0, 6) : live) {
      const id = 'L' + m.address
      if (seen.current.has(id)) continue
      seen.current.add(id)
      fresh.push({ id, kind: 'launch', address: m.address, ticker: m.ticker, name: m.name, image: m.image, at: now })
    }
    for (const f of state.flows ?? []) {
      const id = 'D' + f.market + f.batch
      if (seen.current.has(id)) continue
      seen.current.add(id)
      fresh.push({
        id,
        kind: 'death',
        address: f.market,
        ticker: f.ticker,
        total: Number(f.total),
        to: f.survivors.map((s) => ({ ticker: s.ticker, address: s.address, amount: Number(s.amount) })),
        deployers: Number(f.deployers_amount),
        platform: Number(f.platform_amount),
        image: images.current.get(f.market)?.image,
        at: now,
      })
    }
    for (const f of state.fills.slice(0, first.current ? 6 : 14)) {
      const id = 'T' + f.intent
      if (seen.current.has(id)) continue
      seen.current.add(id)
      const m = images.current.get(f.market)
      fresh.push({ id, kind: 'trade', address: f.market, ticker: m?.ticker ?? '???', side: f.side, qty: Number(f.quantity), who: state.names?.[f.participant], image: m?.image, at: now })
    }
    first.current = false
    if (!fresh.length) return
    // Drip new items in so the feed feels continuous between polls.
    fresh.sort((a, b) => (a.kind === 'death' ? -1 : 0) - (b.kind === 'death' ? -1 : 0))
    const timers = fresh.map((item, i) =>
      window.setTimeout(() => setItems((prev) => [item, ...prev].slice(0, 40)), (i / fresh.length) * 1800),
    )
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [state])

  return (
    <div className="feed">
      {items.map((it) => (
        <Link key={it.id} to={'/coin/' + it.address} className={'feed-item feed-' + it.kind + (it.kind === 'trade' ? ' ' + it.side : '')}>
          <CoinTile ticker={it.ticker} image={it.image} size={34} />
          {it.kind === 'launch' && (
            <span className="feed-text">
              <b>🚀 ${it.ticker}</b> launched
              <small>{it.name}</small>
            </span>
          )}
          {it.kind === 'trade' && (
            <span className="feed-text">
              {it.who && <span className="muted">@{it.who}</span>} {it.side === 'buy' ? 'bought' : 'sold'} <em>{short(it.qty)}</em> <b>${it.ticker}</b>
            </span>
          )}
          {it.kind === 'death' && (
            <span className="feed-text">
              <b>💀 ${it.ticker}</b> was cut · <em>{sol(it.total)} SOL</em> set free
              <small className="feed-flow">
                {it.to.slice(0, 4).map((s) => (
                  <span key={s.address}>→ ${s.ticker} +{sol(s.amount)}</span>
                ))}
                {it.deployers > 0 && <span>→ builders +{sol(it.deployers)}</span>}
                <span>→ house +{sol(it.platform)}</span>
              </small>
            </span>
          )}
        </Link>
      ))}
      {!items.length && <p className="feed-empty">The feed lights up with the first trade.</p>}
    </div>
  )
}
