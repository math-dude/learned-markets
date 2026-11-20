import { useRef, useState } from 'react'
import { BatchClash } from '../arena/BatchClash'
import { BubbleArena } from '../arena/BubbleArena'
import { LiveFeed } from '../arena/LiveFeed'
import { RankBoard, TheLine, type Sort } from '../arena/RankBoard'
import { Link } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'
import { Crown } from '../components/icons'
import { CandleChart } from '../pages/coin/PriceChart'
import type { ChainState } from './ChainMarket'

type Market = ChainState['markets'][number]
type Fill = ChainState['fills'][number]

function tokenPrice(price: string) {
  return (Number(price) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })
}

export function MarketHistory({
  market,
  fills,
  candles,
  rounds,
}: {
  market: Market
  fills: Fill[]
  candles: ChainState['candles']
  rounds?: ChainState['rounds']
}) {
  const recent = fills.filter((f) => f.market === market.address)
  const history = candles.map((c) => ({
    o: Number(c.o) / 1e6,
    h: Number(c.h) / 1e6,
    l: Number(c.l) / 1e6,
    c: Number(c.c) / 1e6,
    v: Number(c.v),
  }))
  const ids = candles.map((c) => c.batch)
  const latest = recent.filter((f) => f.batch === recent[0]?.batch)
  const round = rounds?.find((r) => r.market === market.address)
  const buys = round ? Number(round.buys) : latest.filter((f) => f.side === 'buy').reduce((n, f) => n + Number(f.quantity), 0)
  const sells = round ? Number(round.sells) : latest.filter((f) => f.side === 'sell').reduce((n, f) => n + Number(f.quantity), 0)
  const shownBatch = round?.batch ?? recent[0]?.batch
  return (
    <div className="paper-history">
      <CandleChart
        candles={history}
        price={Number(market.price) / 1e6}
        ticker={market.ticker}
        unit="lamports"
        caption={(i) => 'Batch ' + ids[i].toLocaleString()}
      />
      <section className="panel round-panel">
        <div className="panel-head">
          <h2>Last batch</h2>
          <small>{shownBatch !== undefined ? 'Batch ' + shownBatch.toLocaleString() : 'Awaiting fills'}</small>
        </div>
        <BatchClash buys={buys} sells={sells} batch={shownBatch} />
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Trades</h2>
          <small>Confirmed on Surfpool</small>
        </div>
        <div className="trade-scroll">
          <table className="trade-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Side</th>
                <th>Tokens</th>
                <th>Price · lamports</th>
                <th>Batch</th>
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 30).map((f) => (
                <tr key={f.intent} className="lm-fillrow" title={'Transaction ' + f.signature}>
                  <td>
                    {f.participant.slice(0, 4)}…{f.participant.slice(-4)}
                  </td>
                  <td className={f.side === 'buy' ? 'green' : 'red'}>{f.side}</td>
                  <td>{BigInt(f.quantity).toLocaleString()}</td>
                  <td>{f.price === null ? '—' : tokenPrice(f.price)}</td>
                  <td>{f.batch.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!recent.length && <p className="paper-empty">Your first confirmed trade appears here.</p>}
      </section>
    </div>
  )
}

function roundsFor(state: ChainState) {
  if (state.rounds?.length) return state.rounds
  // Fall back to confirmed fills grouped by market and batch.
  const map = new Map<string, NonNullable<ChainState['rounds']>[number]>()
  for (const f of state.fills) {
    const key = f.market + ':' + f.batch
    const r = map.get(key) ?? { market: f.market, batch: f.batch, buys: '0', sells: '0', matched: '0', maker_side: null, maker_qty: '0', price: f.price }
    if (f.side === 'buy') r.buys = String(Number(r.buys) + Number(f.quantity))
    else r.sells = String(Number(r.sells) + Number(f.quantity))
    map.set(key, r)
  }
  return [...map.values()].sort((a, b) => b.batch - a.batch)
}

export function ValidatorBoard({ state }: { state: ChainState }) {
  const [sort, setSort] = useState<Sort>('Hot')
  const rounds = roundsFor(state)
  const latestBatch = rounds[0]?.batch
  const latest = rounds.filter((r) => r.batch === latestBatch)
  const totalBuys = latest.reduce((n, r) => n + Number(r.buys), 0)
  const totalSells = latest.reduce((n, r) => n + Number(r.sells), 0)
  const byMarket = new Map<string, typeof rounds>()
  for (const r of rounds) byMarket.set(r.market, [...(byMarket.get(r.market) ?? []), r])
  const volume = (address: string) =>
    (byMarket.get(address) ?? []).reduce((n, r) => n + (Number(r.buys) + Number(r.sells)) * Number(r.price ?? 0), 0)
  const live = state.markets.filter((m) => m.live)
  const dead = state.markets.filter((m) => !m.live)
  const listed =
    sort === 'Graveyard'
      ? dead
      : [...live].sort((a, b) =>
          sort === 'Hot'
            ? volume(b.address) - volume(a.address) || b.heat - a.heat
            : sort === 'Liquidity'
              ? Number(b.reserve_cash) - Number(a.reserve_cash)
              : 0,
        )
  // Re-rank at most every 8 s so cards do not shuffle under the cursor on every poll.
  const order = useRef<{ key: string; at: number; ids: string[] }>({ key: '', at: 0, ids: [] })
  const now = Date.now()
  if (order.current.key !== sort || now - order.current.at > 8000) order.current = { key: sort, at: now, ids: listed.map((m) => m.address) }
  const rank = new Map(order.current.ids.map((id, i) => [id, i]))
  listed.sort((a, b) => (rank.get(a.address) ?? -1) - (rank.get(b.address) ?? -1))
  const leader = [...live].sort((a, b) => volume(b.address) - volume(a.address))[0]
  const phase = state.slot % state.batch_slots
  const freed = (state.flows ?? []).reduce((n, f) => n + Number(f.total), 0)
  return (
    <main className="arena-page">
      <section className="arena-hero">
        <div className="hero-copy">
          <span className="eyebrow glow-text">Live on Solana · batch auctions every {(state.batch_slots * 0.4).toFixed(1)}s</span>
          <h1>
            No snipers. No front-running.
            <br />
            <span className="hero-grad">Just memes and the fairest price.</span>
          </h1>
          <div className="hero-stats">
            <div>
              <strong>{live.length}</strong>
              <small>live coins</small>
            </div>
            <div>
              <strong>{dead.length}</strong>
              <small>cut so far</small>
            </div>
            <div>
              <strong>{(freed / 1e9).toFixed(3)}</strong>
              <small>SOL recycled to survivors</small>
            </div>
            <div className="hero-clock">
              <svg viewBox="0 0 44 44">
                <circle cx="22" cy="22" r="19" className="clock-bg" />
                <circle
                  cx="22"
                  cy="22"
                  r="19"
                  className="clock-fg"
                  style={{ strokeDashoffset: 119.4 * (1 - phase / state.batch_slots) }}
                />
              </svg>
              <span>
                <strong>{state.batch_slots - phase}</strong>
                <small>slots to clear</small>
              </span>
            </div>
          </div>
        </div>
        {leader && (
          <Link className="king" to={'/coin/' + leader.address}>
            <span className="king-crown">
              <Crown />
            </span>
            <CoinTile ticker={leader.ticker} image={leader.image} size={92} />
            <span>
              <small>King of the hill</small>
              <strong>{leader.name}</strong>
              <em>${leader.ticker}</em>
            </span>
          </Link>
        )}
      </section>

      <section className="arena-stage">
        <BubbleArena state={state} />
        <div className="stage-clash">
          <BatchClash buys={totalBuys} sells={totalSells} batch={latestBatch} label={latestBatch !== undefined ? 'Batch #' + latestBatch.toLocaleString() + ' · all coins' : undefined} />
        </div>
      </section>

      <div className="arena-columns">
        <section className="terminal">
          <div className="grid-head">
            <h2>Board</h2>
            <div className="seg">
              {(['Hot', 'Liquidity', 'Movers', 'Rookies', 'Newest', 'Graveyard'] as const).map((option) => (
                <button key={option} aria-pressed={sort === option} onClick={() => setSort(option)}>
                  {option}
                </button>
              ))}
            </div>
          </div>
          <RankBoard state={state} rounds={rounds} sort={sort} />
        </section>
        <aside className="feed-wrap">
          <div className="grid-head">
            <h2>The Line</h2>
            <Link className="launch-cta" to="/launch">
              Launch a coin
            </Link>
          </div>
          <TheLine state={state} />
          <div className="grid-head feed-head">
            <h2>
              <span className="live-dot" /> Live
            </h2>
          </div>
          <LiveFeed state={state} />
        </aside>
      </div>
    </main>
  )
}

export function MarketHeading({ market, fills }: { market: Market; fills: Fill[] }) {
  const recent = fills.filter((f) => f.market === market.address)
  const traders = new Set(recent.map((f) => f.participant)).size
  return (
    <header className="live-coin-header">
      <Link to="/" className="coin-back">
        ← Board
      </Link>
      <div className="live-coin-name">
        <CoinTile ticker={market.ticker} image={market.image} size={72} />
        <div>
          <div className="coin-title-line">
            <h1>{market.name}</h1>
            <small>${market.ticker}</small>
            <span className="badge badge-outline">{market.stage}</span>
          </div>
          <strong className="coin-header-price">
            {tokenPrice(market.price)} <small>lamports</small>
          </strong>
        </div>
      </div>
      <div className="live-coin-stats">
        <div>
          <small>Market cap</small>
          <strong>{(Number(market.price) / 1e6).toFixed(3)} SOL</strong>
        </div>
        <div>
          <small>Traded volume</small>
          <strong>
            {recent
              .reduce((sum, f) => sum + (Number(f.quantity) * Number(f.price ?? 0)) / 1e15, 0)
              .toFixed(3)}{' '}
            SOL
          </strong>
        </div>
        <div>
          <small>Recent traders</small>
          <strong>{traders}</strong>
        </div>
      </div>
    </header>
  )
}

export function SurvivalPanel({ market }: { market: Market }) {
  return (
    <section className="card survival-panel">
      <small>{market.stage === 'Line' ? 'In the Line' : 'Survival budget'}</small>
      <strong>
        {market.stage === 'Line'
          ? market.heat.toFixed(1) + ' heat'
          : Math.max(0, market.survival ?? 0).toFixed(1)}
      </strong>
      {market.stage !== 'Line' && <small>activity units remaining</small>}
      <div className="survival-track">
        <i
          style={{ width: Math.min(100, (Math.max(0, market.survival ?? market.heat) / 300) * 100) + '%' }}
        />
      </div>
      <p>
        {market.stage === 'Line'
          ? 'Activity earns a rookie seat at the next epoch. Cold coins can be cut.'
          : 'Distinct qualifying traders add survival relative to the board average. The board checks survival each epoch.'}
      </p>
      <small>Accelerated Surfpool demo · 12 batches per epoch</small>
    </section>
  )
}
