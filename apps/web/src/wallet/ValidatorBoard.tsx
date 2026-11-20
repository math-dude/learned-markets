import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'
import { Crown } from '../components/icons'
import { tintFor } from '../market/tints'
import { CandleChart } from '../pages/coin/PriceChart'
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

export function MarketHistory({
  market,
  fills,
  candles,
}: {
  market: Market
  fills: Fill[]
  candles: ChainState['candles']
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
  const buys = latest.filter((f) => f.side === 'buy').reduce((n, f) => n + Number(f.quantity), 0)
  const sells = latest.filter((f) => f.side === 'sell').reduce((n, f) => n + Number(f.quantity), 0)
  const matched = Math.min(buys, sells)
  const scale = Math.max(1, buys, sells)
  const percent = (value: number) => (value / scale) * 100 + '%'
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
          <h2>Last settled round</h2>
          <small>{recent[0] ? 'Batch ' + recent[0].batch.toLocaleString() : 'Awaiting fills'}</small>
        </div>
        <div className="round-totals">
          <span className="green">Buys {buys.toLocaleString()} tokens</span>
          <span className="red">Sells {sells.toLocaleString()} tokens</span>
        </div>
        <div className="round-match-animation" key={recent[0]?.batch}>
          <div className="round-half round-buy">
            <i style={{ width: percent(buys - matched) }} />
            <b style={{ width: percent(matched) }} />
          </div>
          <span className="round-center" />
          <div className="round-half round-sell">
            <b style={{ width: percent(matched) }} />
            <i style={{ width: percent(sells - matched) }} />
          </div>
        </div>
        <div className="round-maker-track">
          <i
            key={recent[0]?.batch}
            style={{
              width: (Math.abs(buys - sells) / scale) * 45 + '%',
              marginLeft: buys >= sells ? '50%' : 50 - (Math.abs(buys - sells) / scale) * 45 + '%',
            }}
          />
        </div>
        <div className="round-legend">
          <span>
            <i />
            Matched · {matched.toLocaleString()} tokens
          </span>
          <span>
            <i />
            Maker fills {Math.abs(buys - sells).toLocaleString()} tokens of net demand
          </span>
        </div>
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

export function ValidatorBoard({ state }: { state: ChainState }) {
  const [sort, setSort] = useState<'Volume' | 'Newest' | 'Ended'>('Volume')
  const previous = useRef(new Set(state.markets.map((m) => m.address)))
  const [arrival, setArrival] = useState('')
  useEffect(() => {
    const launched = state.markets.find((m) => !previous.current.has(m.address))
    previous.current = new Set(state.markets.map((m) => m.address))
    if (launched) setArrival(launched.address)
  }, [state.markets])
  const volume = new Map<string, bigint>()
  for (const f of state.fills) volume.set(f.market, (volume.get(f.market) ?? 0n) + BigInt(f.quantity))
  const ranked = state.markets
    .filter((m) => m.live)
    .sort((a, b) => {
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
            {(['Volume', 'Newest', 'Ended'] as const).map((option) => (
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
          <div
            className="validator-ranks"
            style={{
              height: (sort === 'Ended' ? state.markets.filter((m) => !m.live).length : ranked.length) * 104,
            }}
          >
            {(sort === 'Volume'
              ? ranked
              : state.markets.filter((m) => (sort === 'Ended' ? !m.live : m.live))
            ).map((m, i) => (
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

export function MarketHeading({ market, fills }: { market: Market; fills: Fill[] }) {
  const recent = fills.filter((f) => f.market === market.address)
  const traders = new Set(recent.map((f) => f.participant)).size
  return (
    <header className="live-coin-header">
      <Link to="/" className="coin-back">
        ← Board
      </Link>
      <div className="live-coin-name">
        <CoinTile ticker={market.ticker} tint={tintFor(market.address.charCodeAt(0))} size={64} />
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
