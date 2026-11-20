import { useEffect, useRef, useState } from 'react'
import { BatchClash } from '../arena/BatchClash'
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

// Slot duration learned from how fast slots arrive, for the chart time axis.
const slotClock = { slot: 0, at: 0, ms: 400 }
function learnSlot(slot: number) {
  if (slot === slotClock.slot) return slotClock
  const t = Date.now()
  const per = (t - slotClock.at) / Math.max(1, slot - slotClock.slot)
  if (slotClock.at && slot > slotClock.slot && per > 50 && per < 2000) slotClock.ms = slotClock.ms * 0.6 + per * 0.4
  slotClock.slot = slot
  slotClock.at = t
  return slotClock
}

export function MarketHistory({
  market,
  fills,
  candles,
  rounds,
  names = {},
  slot,
  batchSlots,
}: {
  market: Market
  fills: Fill[]
  candles: ChainState['candles']
  rounds?: ChainState['rounds']
  names?: Record<string, string>
  slot?: number
  batchSlots?: number
}) {
  // When each batch cleared, estimated once from the slot clock so candles keep their second.
  const cleared = useRef(new Map<number, number>())
  let times: number[] | undefined
  if (slot && batchSlots) {
    const { ms } = learnSlot(slot)
    times = candles.map((c) => {
      const known = cleared.current.get(c.batch)
      if (known) return known
      const at = Date.now() - Math.max(0, slot - (c.batch + 1) * batchSlots) * ms
      cleared.current.set(c.batch, at)
      return at
    })
  }
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
        times={times}
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
                <th>Trader</th>
                <th>Side</th>
                <th>Tokens</th>
                <th>Price · lamports</th>
                <th>Batch</th>
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 30).map((f) => (
                <tr key={f.intent} className="lm-fillrow" title={'Transaction ' + f.signature}>
                  <td>{names[f.participant] ? '@' + names[f.participant] : f.participant.slice(0, 4) + '…' + f.participant.slice(-4)}</td>
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

function BatchClock({ slot, batchSlots }: { slot: number; batchSlots: number }) {
  // Interpolate between polls; learn the slot duration from how fast slots arrive.
  const [now, setNow] = useState(() => Date.now())
  const seen = useRef({ slot, at: Date.now(), ms: 400 })
  if (slot !== seen.current.slot) {
    const t = Date.now()
    const per = (t - seen.current.at) / Math.max(1, slot - seen.current.slot)
    const ms = slot > seen.current.slot && per > 50 && per < 2000 ? seen.current.ms * 0.6 + per * 0.4 : seen.current.ms
    seen.current = { slot, at: t, ms }
  }
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(t)
  }, [])
  const { ms, at } = seen.current
  const elapsedSlots = slot % batchSlots + (now - at) / ms
  const total = batchSlots * ms
  const left = Math.max(0, total - (elapsedSlots % batchSlots) * ms)
  return (
    <>
      <div className="epoch-clock">
        {(left / 1000).toFixed(1)}
        <small style={{ fontSize: 28 }}>s</small>
      </div>
      <div className="epoch-segments" aria-hidden="true">
        {Array.from({ length: 24 }, (_, i) => (
          <i key={i} className={i / 24 < 1 - left / total ? 'lit' : ''} />
        ))}
      </div>
    </>
  )
}

export function ValidatorBoard({ state }: { state: ChainState }) {
  const [sort, setSort] = useState<Sort>('Hot')
  const rounds = roundsFor(state)
  const latestBatch = rounds[0]?.batch
  const latest = rounds.filter((r) => r.batch === latestBatch)
  const totalBuys = latest.reduce((n, r) => n + Number(r.buys), 0)
  const totalSells = latest.reduce((n, r) => n + Number(r.sells), 0)
  const live = state.markets.filter((m) => m.live)
  const volume = new Map<string, number>()
  for (const r of rounds) volume.set(r.market, (volume.get(r.market) ?? 0) + (Number(r.buys) + Number(r.sells)) * Number(r.price ?? 0))
  const leader = [...live].sort((a, b) => (volume.get(b.address) ?? 0) - (volume.get(a.address) ?? 0))[0]
  const ticker = (address: string) => state.markets.find((m) => m.address === address)?.ticker ?? '???'
  const headlines = [
    ...(state.flows ?? []).slice(0, 6).map(
      (f) =>
        '$' + f.ticker + ' was cut · ' + (Number(f.total) / 1e9).toFixed(3) + ' SOL recycled to ' + f.survivors.slice(0, 3).map((s) => '$' + s.ticker).join(', '),
    ),
    ...live.slice(0, 6).map((m) => '$' + m.ticker + (m.stage === 'Line' ? ' joined the Line' : m.stage === 'Rookie' ? ' seated as a rookie' : ' is a regular')),
    ...state.fills.slice(0, 4).map((f) => '$' + ticker(f.market) + ' ' + (f.side === 'buy' ? 'bought' : 'sold') + ' ' + BigInt(f.quantity).toLocaleString()),
  ]
  return (
    <main className="market-board">
      <section className="epoch-hero paper-hero">
        {leader ? (
          <Link className="paper-king" to={'/coin/' + leader.address}>
            <span style={{ position: 'relative' }}>
              <CoinTile ticker={leader.ticker} image={leader.image} size={82} />
              <span className="paper-crown lm-crown">
                <Crown />
              </span>
            </span>
            <span>
              <small className="gold">#1 · king of the hill</small>
              <strong>{leader.name}</strong>
              <small>${leader.ticker} · LIQ {(Number(leader.reserve_cash) / 1e9).toFixed(3)} SOL</small>
            </span>
          </Link>
        ) : (
          <span />
        )}
        <div>
          <span className="eyebrow">Batch closes in</span>
          <BatchClock slot={state.slot} batchSlots={state.batch_slots} />
          <small className="muted">Batch {Math.floor(state.slot / state.batch_slots).toLocaleString()} · one clearing price for everyone</small>
        </div>
        <div className="hero-counts">
          <div>
            <strong>{live.length}</strong>
            <small>live</small>
          </div>
          <div>
            <strong className="gold">{live.filter((m) => m.stage === 'Rookie').length}</strong>
            <small>rookies</small>
          </div>
          <div>
            <strong>{live.filter((m) => m.stage === 'Line').length}</strong>
            <small>in the Line</small>
          </div>
          <div>
            <strong>{state.markets.length - live.length}</strong>
            <small>cut</small>
          </div>
        </div>
      </section>
      <div className="headlines">
        <div className="headlines-label">Live</div>
        {headlines.length ? (
          <div className="validator-tape-window">
            <div className="lm-ticker validator-tape">
              {[0, 1].map((i) => (
                <span key={i} aria-hidden={i === 1}>
                  {headlines.map((h, j) => (
                    <span key={j} className="tape-item">
                      <i>◆</i>
                      {h}
                    </span>
                  ))}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <span className="paper-tape">Waiting for the first fill</span>
        )}
      </div>
      <div className="paper-grid">
        <section className="board-list">
          <div className="panel-head">
            <h1 className="section-title">Board</h1>
          </div>
          <div className="board-filters">
            {(['Hot', 'Liquidity', 'Movers', 'Rookies', 'Newest', 'Graveyard'] as const).map((option) => (
              <button key={option} className="pill-btn" aria-pressed={sort === option} onClick={() => setSort(option)}>
                {option === 'Hot' ? 'Volume' : option === 'Movers' ? 'Price change' : option}
              </button>
            ))}
          </div>
          <div className="board-round">
            <BatchClash
              buys={totalBuys}
              sells={totalSells}
              batch={latestBatch}
              label={latestBatch !== undefined ? 'Batch ' + latestBatch.toLocaleString() + ' · all coins' : undefined}
            />
          </div>
          <RankBoard state={state} rounds={rounds} sort={sort} />
        </section>
        <aside className="board-side">
          <div className="panel-head">
            <h2>The Line</h2>
            <Link className="pill-btn" to="/launch">
              Launch a coin
            </Link>
          </div>
          <TheLine state={state} />
          <div className="panel-head">
            <h2>Activity</h2>
          </div>
          <LiveFeed state={state} />
        </aside>
      </div>
    </main>
  )
}

export function MarketHeading({ market, fills, solUsd }: { market: Market; fills: Fill[]; solUsd?: number | null }) {
  // One billion tokens at the last clearing price.
  const cap = Number(market.price) / 1e6
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
          <strong>
            {solUsd
              ? '$' + (cap * solUsd).toLocaleString('en-US', { maximumFractionDigits: cap * solUsd < 1000 ? 2 : 0 })
              : cap.toFixed(3) + ' SOL'}
          </strong>
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
