import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'
import { Crown } from '../components/icons'
import type { ChainState } from '../wallet/ChainMarket'

type Market = ChainState['markets'][number]
type Round = NonNullable<ChainState['rounds']>[number]
export type Sort = 'Hot' | 'Liquidity' | 'Movers' | 'Rookies' | 'Newest' | 'Graveyard'

const ROW = 96
const GRAD_ACTIVITY = 12 // accelerated Surfpool profile (live_lifecycle.PROFILE)
const SEAT_HEAT = 2
const sparks = [
  ['-34px', '-18px', '#FBBF24'],
  ['30px', '-22px', '#C084FC'],
  ['-28px', '16px', '#22D3EE'],
  ['36px', '14px', '#FBBF24'],
  ['0px', '-30px', '#F472B6'],
  ['4px', '26px', '#7C3AED'],
]
const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n)))
const px = (price: string) => Number((Number(price) / 1e6).toPrecision(4)).toLocaleString()

/** Remembers when each coin first appeared and when its stage last changed, so tags can fade. */
function useHistory(markets: Market[]) {
  const born = useRef(new Map<string, number>())
  const stage = useRef(new Map<string, { stage: string; prev: string; at: number }>())
  const first = useRef(true)
  const now = Date.now()
  for (const m of markets) {
    if (!born.current.has(m.address)) born.current.set(m.address, first.current ? 0 : now)
    const s = stage.current.get(m.address)
    if (!s) stage.current.set(m.address, { stage: m.stage, prev: m.stage, at: 0 })
    else if (s.stage !== m.stage) stage.current.set(m.address, { stage: m.stage, prev: s.stage, at: now })
  }
  first.current = false
  return { born: born.current, stage: stage.current }
}

export function RankBoard({ state, rounds, sort }: { state: ChainState; rounds: Round[]; sort: Sort }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((v) => v + 1), 1000)
    return () => window.clearInterval(t)
  }, [])
  const { born, stage } = useHistory(state.markets)
  const byMarket = new Map<string, Round[]>()
  for (const r of rounds) {
    const list = byMarket.get(r.market)
    if (list) list.push(r)
    else byMarket.set(r.market, [r])
  }
  const traders = new Map<string, Set<string>>()
  for (const f of state.fills) {
    const set = traders.get(f.market) ?? new Set()
    set.add(f.participant)
    traders.set(f.market, set)
  }
  const stats = (m: Market) => {
    const mr = byMarket.get(m.address) ?? []
    const prices = mr.map((r) => Number(r.price ?? 0)).filter(Boolean)
    const change = prices.length > 1 ? (prices[0] / prices[prices.length - 1] - 1) * 100 : 0
    const volume = mr.reduce((n, r) => n + (Number(r.buys) + Number(r.sells)) * Number(r.price ?? 0), 0) / 1e15
    return { last: mr[0], change, volume }
  }
  const now = Date.now()
  const pool = sort === 'Graveyard' ? state.markets.filter((m) => !m.live) : state.markets.filter((m) => m.live && (sort !== 'Rookies' || m.stage === 'Rookie'))
  const info = new Map(pool.map((m) => [m.address, stats(m)]))
  const ranked = [...pool].sort((a, b) => {
    const A = info.get(a.address)!
    const B = info.get(b.address)!
    if (sort === 'Liquidity') return Number(b.reserve_cash) - Number(a.reserve_cash)
    if (sort === 'Movers') return Math.abs(B.change) - Math.abs(A.change)
    if (sort === 'Newest') return (born.get(b.address) ?? 0) - (born.get(a.address) ?? 0)
    if (sort === 'Rookies') return b.activity - a.activity
    return B.volume - A.volume || b.heat - a.heat
  })
  const rank = new Map(ranked.map((m, i) => [m.address, i]))
  // Render in a stable DOM order and move rows with transforms, so re-ranking glides instead of re-mounting.
  const stable = [...pool].sort((a, b) => (a.address < b.address ? -1 : 1))
  return (
    <div className="rank-list" style={{ height: Math.max(1, ranked.length) * ROW }}>
      {stable.map((m) => {
        const i = rank.get(m.address)!
        const { last, change } = info.get(m.address)!
        const s = stage.get(m.address)
        const fresh = now - (born.get(m.address) ?? 0) < 20_000
        const seated = s && s.prev === 'Line' && s.stage === 'Rookie' && now - s.at < 15_000
        const graduated = s && s.stage === 'Regular' && s.prev === 'Rookie' && now - s.at < 15_000
        const danger = m.live && m.stage !== 'Line' && m.survival !== null && m.survival < 25
        const grad = m.stage === 'Rookie' ? Math.min(1, m.activity / GRAD_ACTIVITY) : 0
        const holders = traders.get(m.address)?.size ?? 0
        return (
          <Link
            key={m.address}
            to={'/coin/' + m.address}
            className={'rank-row' + (fresh ? ' is-new' : '') + (danger ? ' is-danger' : '') + (m.live ? '' : ' is-dead') + (i === 0 ? ' is-king' : '')}
            style={{ transform: `translateY(${i * ROW}px)`, zIndex: 100 - Math.min(i, 99) } as CSSProperties}
          >
            {last && <i key={last.batch} className={'row-flash ' + (Number(last.buys) >= Number(last.sells) ? 'buy' : 'sell')} />}
            <span className="rank-n">
              {i === 0 && sort === 'Hot' ? (
                <span className="rank-crown">
                  <Crown width={22} height={16} />
                </span>
              ) : null}
              #{i + 1}
            </span>
            <span className="rank-orb">
              <CoinTile ticker={m.ticker} image={m.image} size={60} />
              <span className={'orb-badge ' + m.stage.toLowerCase()}>{m.live ? m.stage : 'cut'}</span>
            </span>
            <span className="rank-main">
              <span className="rank-title">
                <strong>{m.name}</strong>
                {fresh && m.live && <span className="tag tag-new lm-grad">NEW</span>}
                {m.stage === 'Rookie' && <span className="tag tag-rookie">↑ ROOKIE</span>}
                {seated && <span className="tag tag-seated lm-grad">JUST SEATED</span>}
                {graduated && (
                  <span className="tag-wrap">
                    {sparks.map(([dx, dy, bg]) => (
                      <i key={dx + dy} className="lm-spark" style={{ '--dx': dx, '--dy': dy, background: bg } as CSSProperties} />
                    ))}
                    <span className="tag tag-grad lm-grad">GRADUATED</span>
                  </span>
                )}
                {danger && <span className="tag tag-danger">DANGER</span>}
                {!m.live && <span className="tag tag-dead">{m.ended_reason ?? 'CUT'}</span>}
              </span>
              <span className="rank-sub">
                <span className="mono">${m.ticker}</span>
                <span className="rank-people">● {holders}</span>
                <span className={'rank-timer' + (danger ? ' red' : '')}>
                  ⏱ {m.stage === 'Line' ? m.heat.toFixed(1) + ' heat' : Math.max(0, m.survival ?? 0).toFixed(0) + ' left'}
                </span>
                <span className={change >= 0 ? 'green' : 'red'}>
                  {change >= 0 ? '+' : ''}
                  {change.toFixed(1)}%
                </span>
                {m.stage === 'Rookie' && <span className="gold">graduates at {Math.round(grad * 100)}%</span>}
              </span>
            </span>
            <span className="rank-nums">
              <span>
                <small>LIQ</small> {(Number(m.reserve_cash) / 1e9).toFixed(3)}
              </span>
              <span>
                <small>P</small> {m.price === '0' ? '—' : px(m.price)}
              </span>
              {last && (
                <span className="rank-flow">
                  <b className="green">+{short(Number(last.buys))}</b> <b className="red">−{short(Number(last.sells))}</b>
                </span>
              )}
            </span>
            {m.stage === 'Rookie' && (
              <span className="grad-bar">
                <i style={{ width: grad * 100 + '%' }} />
              </span>
            )}
          </Link>
        )
      })}
      {!ranked.length && <p className="paper-empty">{sort === 'Graveyard' ? 'No coin has been cut yet.' : 'Nothing here yet.'}</p>}
    </div>
  )
}

export function TheLine({ state }: { state: ChainState }) {
  const line = state.markets.filter((m) => m.live && m.stage === 'Line').sort((a, b) => b.heat - a.heat)
  return (
    <div className="line-list">
      {line.slice(0, 10).map((m, i) => {
        const pct = Math.min(1, m.heat / SEAT_HEAT)
        return (
          <Link key={m.address} to={'/coin/' + m.address} className={'line-row' + (pct >= 1 ? ' lm-seat' : '')} style={{ order: i }}>
            <CoinTile ticker={m.ticker} image={m.image} size={38} />
            <span className="line-id">
              <strong>{m.name}</strong>
              <small>${m.ticker}</small>
            </span>
            <span className="line-heat">
              <b>{m.heat.toFixed(1)}</b>
              <small>{pct >= 1 ? 'seats next epoch' : 'heat'}</small>
            </span>
            <span className="line-bar">
              <i style={{ width: pct * 100 + '%' }} />
            </span>
          </Link>
        )
      })}
      {!line.length && <p className="feed-empty">The Line is empty.</p>}
    </div>
  )
}
