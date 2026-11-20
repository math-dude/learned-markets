import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'
import { Crown } from '../components/icons'
import { tintFor } from '../market/tints'
import { CandleChart, type Candle } from '../pages/coin/PriceChart'
import { LaunchSparks } from '../pages/LaunchPage'
import type { ChainState } from './ChainMarket'

type Market = ChainState['markets'][number]
type Fill = ChainState['fills'][number]

function tokenPrice(price: string) {
  return (Number(price) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })
}

function FillList({ fills, markets }: { fills: Fill[]; markets: Market[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Latest fills</h2>
        <small>Confirmed</small>
      </div>
      {fills.slice(0, 12).map((fill) => (
        <Link className="paper-row lm-fillrow" key={fill.intent} to={'/coin/' + fill.market}>
          <span className="paper-row-name">
            <strong>${markets.find((m) => m.address === fill.market)?.ticker ?? 'Market'}</strong>
            <small>Batch {fill.batch.toLocaleString()}</small>
          </span>
          <strong className={fill.side === 'buy' ? 'green' : 'red'}>
            {fill.side === 'buy' ? 'Buy' : 'Sell'} · {BigInt(fill.quantity).toLocaleString()}
          </strong>
        </Link>
      ))}
      {!fills.length && <p className="paper-empty">Waiting for the first confirmed fill.</p>}
    </section>
  )
}

export function MarketHistory({ market, fills }: { market: Market; fills: Fill[] }) {
  const recent = fills.filter((f) => f.market === market.address)
  const candles = new Map<number, Candle>()
  for (const fill of [...recent].reverse()) {
    if (fill.price === null) continue
    const price = Number(fill.price) / 1e6
    const candle = candles.get(fill.batch) ?? { o: price, h: price, l: price, c: price, v: 0 }
    candle.v += Number(fill.quantity)
    candles.set(fill.batch, candle)
  }
  const ids = [...candles.keys()]
  return (
    <div className="paper-history">
      <CandleChart
        candles={[...candles.values()]}
        price={Number(market.price) / 1e6}
        ticker={market.ticker}
        unit="lamports"
        caption={(i) => 'Batch ' + ids[i].toLocaleString()}
      />
      <FillList markets={[market]} fills={recent} />
    </div>
  )
}

export function ValidatorBoard({ state }: { state: ChainState }) {
  const [sort, setSort] = useState<'Volume' | 'Newest'>('Volume')
  const previous = useRef(new Set(state.markets.map((m) => m.address)))
  const [arrival, setArrival] = useState('')
  useEffect(() => {
    const launched = state.markets.find((m) => !previous.current.has(m.address))
    previous.current = new Set(state.markets.map((m) => m.address))
    if (launched) setArrival(launched.address)
  }, [state.markets])
  const volume = new Map<string, bigint>()
  for (const f of state.fills) volume.set(f.market, (volume.get(f.market) ?? 0n) + BigInt(f.quantity))
  const ranked = [...state.markets].sort((a, b) => {
    const diff = (volume.get(b.address) ?? 0n) - (volume.get(a.address) ?? 0n)
    return diff > 0n ? 1 : diff < 0n ? -1 : 0
  })
  const leader = ranked.find((m) => volume.has(m.address))
  const phase = state.slot % state.batch_slots
  const tape = state.fills.slice(0, 8).map((f) => {
    const market = state.markets.find((m) => m.address === f.market)
    return (
      '$' +
      (market?.ticker ?? 'Market') +
      '   ·   ' +
      f.side.toUpperCase() +
      ' ' +
      BigInt(f.quantity).toLocaleString()
    )
  })
  return (
    <main className="market-board">
      <section className="epoch-hero paper-hero">
        {leader ? (
          <Link className="paper-king" to={'/coin/' + leader.address}>
            <CoinTile ticker={leader.ticker} tint="#342d24" size={82}>
              <span key={leader.address} className="paper-crown lm-crown">
                <Crown />
              </span>
            </CoinTile>
            <span>
              <small className="gold">King of the hill</small>
              <strong>{leader.name}</strong>
              <small>Leader by recent volume</small>
            </span>
          </Link>
        ) : (
          <Link to="/launch">Launch a coin ↗</Link>
        )}
        <div>
          <span className="eyebrow">Batch closes in</span>
          <div className="epoch-clock">
            {state.batch_slots - phase}
            <small> slots</small>
          </div>
          <div className="epoch-segments" aria-hidden="true">
            {Array.from({ length: 16 }, (_, i) => (
              <i key={i} className={(i * state.batch_slots) / 16 <= phase ? 'lit' : ''} />
            ))}
          </div>
          <small>Batch {Math.floor(state.slot / state.batch_slots).toLocaleString()}</small>
        </div>
        <div className="hero-counts">
          <div>
            <strong>{state.markets.length}</strong>
            <small>markets</small>
          </div>
          <div>
            <Link className="chip chip-strong" to="/launch">
              Launch a coin ↗
            </Link>
          </div>
        </div>
      </section>
      <div className="headlines">
        <div className="headlines-label">Trade tape</div>
        {tape.length ? (
          <div className="validator-tape-window">
            <div className="lm-ticker validator-tape">
              {[0, 1].map((i) => (
                <span key={i} aria-hidden={i === 1}>
                  {tape.join('　　 ◆　　 ')}　　 ◆　　{' '}
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
            {(['Volume', 'Newest'] as const).map((option) => (
              <button
                key={option}
                className="pill-btn"
                aria-pressed={sort === option}
                onClick={() => setSort(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <div className="validator-ranks" style={{ height: state.markets.length * 104 }}>
            {(sort === 'Volume' ? ranked : state.markets).map((m, i) => (
              <Link
                className="board-row connected-row"
                key={m.address}
                to={'/coin/' + m.address}
                style={{ transform: 'translateY(' + 104 * i + 'px)' }}
              >
                <span className="board-rank">#{i + 1}</span>
                <CoinTile ticker={m.ticker} tint={tintFor(m.address.charCodeAt(0))}>
                  {m.address === arrival && <LaunchSparks />}
                </CoinTile>
                <span className="board-identity">
                  <strong>{m.name}</strong>
                  <small>
                    ${m.ticker} · {m.stage}
                  </small>
                </span>
                <span className="board-numbers">
                  <strong>{m.price === '0' ? 'Opening' : tokenPrice(m.price)}</strong>
                  <small>lamports / token</small>
                </span>
              </Link>
            ))}
          </div>
          {!ranked.length && <p className="paper-empty">No confirmed launches yet.</p>}
        </section>
        <FillList fills={state.fills} markets={state.markets} />
      </div>
    </main>
  )
}
