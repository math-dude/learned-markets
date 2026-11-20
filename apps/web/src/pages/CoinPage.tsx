import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { CoinTile, StatusBadge } from '../components/CoinBits'
import { BackIcon } from '../components/icons'
import { money, num, signed, signedPct, timeLeft, timeLeftLong } from '../lib/format'
import { useStore } from '../lib/store'
import { useNow } from '../lib/useNow'
import { market, useMarket } from '../market/engine'
import { FEE, OWNERSHIP_CAP_SOL, STATUS_HELP, priceOf } from '../market/seed'
import type { Coin } from '../market/types'
import { PriceChart } from './coin/PriceChart'
import { COLLECT_TICKS, RoundSim, TICK_MS, type Side } from './coin/roundSim'
import './coin.css'

export function CoinPage() {
  const { ticker = '' } = useParams()
  const s = useMarket()
  const coin = market.findCoin(ticker, s)
  if (!coin) return <CoinGone ticker={ticker.toUpperCase()} />
  return <CoinView key={coin.ticker} ticker={coin.ticker} />
}

function CoinGone({ ticker }: { ticker: string }) {
  const s = useMarket()
  const past = s.past.find((p) => p.ticker === ticker)
  const inLine = s.line.find((l) => l.ticker === ticker)
  return (
    <main style={{ padding: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
      <span style={{ fontSize: 20, fontWeight: 700 }}>{past ? `$${ticker} died at the epoch` : inLine ? `${inLine.name} is still in the Line` : `$${ticker} isn't on the Board`}</span>
      <span className="muted" style={{ maxWidth: 420, lineHeight: 1.45 }}>
        {past
          ? `Its survival timer ran out and it was delisted. Holders were not paid out (you lost ${past.put.toFixed(2)} SOL).`
          : inLine
            ? 'Coins in the Line can be traded once they are seated on the Board at an epoch.'
            : 'It may have died at an epoch, or the ticker is wrong.'}
      </span>
      <Link to="/" className="btn-primary" style={{ padding: '11px 22px' }}>
        Go to the Board
      </Link>
    </main>
  )
}

function CoinView({ ticker }: { ticker: string }) {
  const [sim] = useState(() => new RoundSim(ticker))
  useEffect(() => {
    sim.start()
    return () => sim.stop()
  }, [sim])
  const s = useMarket()
  const coin = market.findCoin(ticker, s)!
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', flex: 1 }}>
      <main style={{ flex: '999 1 640px', minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
        <CoinHeader coin={coin} />
        <PriceChart sim={sim} price={priceOf(coin)} ticker={ticker} />
        <RoundPanel sim={sim} />
        <TradesTable sim={sim} ticker={ticker} />
      </main>
      <aside style={{ flex: '1 1 340px', minWidth: 0, maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px' }}>
        <TradePanel sim={sim} coin={coin} />
        <PositionCard coin={coin} />
        <SurvivalCard sim={sim} coin={coin} />
        <section aria-label="Maker status" className="card" style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <StatusBadge status={coin.status} />
          <span className="muted" style={{ fontSize: 14, lineHeight: 1.45 }}>
            {STATUS_HELP[coin.status]}
          </span>
        </section>
      </aside>
    </div>
  )
}

function CoinHeader({ coin }: { coin: Coin }) {
  const s = useMarket()
  const rank = market.rankOf(coin.ticker, s)
  const day = (coin.mcNum / coin.openMc - 1) * 100
  return (
    <section aria-label="Coin" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18, padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
      <Link to="/" className="muted" style={{ fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <BackIcon />
        Board
      </Link>
      <CoinTile tint={coin.tint} ticker={coin.ticker} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ fontWeight: 700, fontSize: 24, margin: 0 }}>{coin.name}</h1>
          <span className="muted">${coin.ticker}</span>
          <StatusBadge status={coin.status} />
          <span className="badge" style={{ background: rank === 1 ? 'rgba(251,191,36,0.12)' : '#1F1F23', color: rank === 1 ? 'var(--gold)' : 'var(--muted)' }}>
            {rank === 1 ? 'king of the hill' : `#${rank} on the board`}
          </span>
        </span>
        <span className="tnum" style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontSize: 28, fontWeight: 700 }}>{priceOf(coin).toFixed(5)}</span>
          <span className="muted" style={{ fontSize: 14 }}>
            SOL
          </span>
          <span style={{ color: day >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{signedPct(day)} 24h</span>
        </span>
      </div>
      <div className="tnum" style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 28 }}>
        <Stat label="Market cap" value={money(coin.mcNum)} />
        <Stat label="Organic volume" value={money(coin.ovNum)} />
        <Stat label="Maker's share" value={`${coin.makerShare}%`} />
        <Stat label="Holders" value={num(coin.holders)} />
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}

function RoundPanel({ sim }: { sim: RoundSim }) {
  const st = useStore(sim.store)
  const { b, s, bc, sc } = sim.totals()
  const m = st.phase === 'collect' ? 0 : Math.min(b, s)
  const SCALE = 5.5
  const pct = (v: number) => (Math.min(100, (Math.max(0, v) / SCALE) * 100)).toFixed(2) + '%'
  const matchShown = st.phase === 'match' ? m : 0
  const r = st.result
  const closesLeft = Math.max(0, ((COLLECT_TICKS - st.t) * TICK_MS) / 1000)
  const status =
    st.phase === 'collect'
      ? `collecting orders · closes in ${closesLeft.toFixed(1)}s`
      : st.phase === 'match'
        ? `round closed · matching ${m.toFixed(2)} SOL of buys against sells`
        : 'cleared · next round starting'
  const barT = st.phase === 'collect' ? (st.t > 0 ? '0.26s linear' : '0.7s cubic-bezier(.45,0,.2,1)') : st.phase === 'match' ? '0s' : '0.9s cubic-bezier(.45,0,.2,1)'
  const matchBg = (fallback: string) => (st.phase === 'collect' ? fallback : 'var(--match)')
  const glow = st.phase === 'match' ? '0 0 16px rgba(217,180,91,0.45)' : '0 0 0 rgba(217,180,91,0)'
  const centerLit = st.phase === 'clear' && st.t < 28
  const ease = 'cubic-bezier(.4,0,.2,1)'
  return (
    <section aria-label="This round" className="card" style={{ margin: '12px 20px', padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>Round {st.roundNo.toLocaleString()}</span>
        <span className="muted" style={{ fontSize: 14 }}>
          {status}
        </span>
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
          no order book · everyone in a round fills at one price
        </span>
      </div>
      <div className="tnum" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
        <span className="green" style={{ fontWeight: 600 }}>
          Buys {b.toFixed(2)} SOL <span className="muted" style={{ fontWeight: 400 }}>· {bc} orders</span>
        </span>
        <span className="red" style={{ fontWeight: 600 }}>
          <span className="muted" style={{ fontWeight: 400 }}>
            {sc} orders ·{' '}
          </span>
          Sells {s.toFixed(2)} SOL
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', height: 34 }}>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', height: 34 }}>
          <div style={{ height: 34, width: pct(b - m), background: 'var(--green)', borderRadius: '6px 0 0 6px', transition: `width ${barT}` }} />
          <div style={{ height: 34, width: pct(matchShown), background: matchBg('var(--green)'), borderRadius: b - m > 0.005 ? 0 : '6px 0 0 6px', boxShadow: glow, transition: `width ${barT}, background 1.2s ${ease}, box-shadow 1.2s ${ease}` }} />
        </div>
        <div aria-hidden="true" style={{ width: 2, height: 46, flex: 'none', background: centerLit ? '#F7DC94' : 'var(--text)', boxShadow: centerLit ? '0 0 14px rgba(217,180,91,0.8)' : 'none', transition: `background 0.9s ${ease}, box-shadow 0.9s ${ease}` }} />
        <div style={{ flex: 1, display: 'flex', height: 34 }}>
          <div style={{ height: 34, width: pct(matchShown), background: matchBg('var(--red)'), borderRadius: s - m > 0.005 ? 0 : '0 6px 6px 0', boxShadow: glow, transition: `width ${barT}, background 1.2s ${ease}, box-shadow 1.2s ${ease}` }} />
          <div style={{ height: 34, width: pct(s - m), background: 'var(--red)', borderRadius: '0 6px 6px 0', transition: `width ${barT}` }} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', height: 14 }}>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ height: 14, width: r && r.left < 0 ? pct(r.maker) : '0%', background: 'var(--accent-2)', borderRadius: '6px 0 0 6px', transition: 'width 0.9s cubic-bezier(.45,0,.2,1)' }} />
        </div>
        <div aria-hidden="true" style={{ width: 2, flex: 'none' }} />
        <div style={{ flex: 1, display: 'flex' }}>
          <div style={{ height: 14, width: r && r.left > 0 ? pct(r.maker) : '0%', background: 'var(--accent-2)', borderRadius: '0 6px 6px 0', transition: 'width 0.9s cubic-bezier(.45,0,.2,1)' }} />
        </div>
      </div>
      <div className="muted" style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
        <span className="legend">
          <span style={{ background: 'var(--match)' }} />
          matched, cancels out
        </span>
        <span className="legend">
          <span style={{ background: 'var(--accent-2)' }} />
          maker absorbs part of the leftover
        </span>
        {r && (
          <span className="tnum" style={{ marginLeft: 'auto', fontWeight: 600, color: r.move < 0 ? 'var(--red)' : 'var(--green)' }}>
            leftover {Math.abs(r.left).toFixed(2)} SOL {r.left >= 0 ? 'buy' : 'sell'} · maker took {r.maker.toFixed(2)} · price {signedPct(r.move * 100, 2)}
          </span>
        )}
      </div>
    </section>
  )
}

function TradesTable({ sim, ticker }: { sim: RoundSim; ticker: string }) {
  const st = useStore(sim.store)
  const cols = '1.3fr 0.7fr 1fr 1fr 1fr 0.9fr'
  return (
    <section aria-label="Trades" style={{ padding: '6px 20px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0 10px' }}>
        <span style={{ fontWeight: 600, fontSize: 16 }}>Trades</span>
        <span className="muted" style={{ fontSize: 13 }}>
          filled each round
        </span>
      </div>
      <div className="table-scroll" role="table" aria-label="Recent fills">
        <div role="row" className="grid-row grid-head" style={{ minWidth: 560, gridTemplateColumns: cols }}>
          {['Account', 'Side', 'SOL', ticker, 'Price', 'Round'].map((h, i) => (
            <span role="columnheader" key={h} className={i >= 2 ? 'right' : ''} style={{ padding: '8px 10px' }}>
              {h}
            </span>
          ))}
        </div>
        {st.fills.map((f) => (
          <div role="row" key={f.id} className={'grid-row' + (f.fresh ? ' lm-fillrow' : '')} style={{ minWidth: 560, gridTemplateColumns: cols, fontSize: 14, borderBottom: '1px solid #18181B', borderRadius: 6 }}>
            <span role="cell" style={{ padding: '8px 10px', color: f.mine ? 'var(--violet-hi)' : 'var(--text-2)', fontWeight: f.mine ? 700 : 400 }}>
              {f.who}
            </span>
            <span role="cell" style={{ padding: '8px 10px', fontWeight: 600, color: f.buy ? 'var(--green)' : 'var(--red)' }}>
              {f.buy ? 'Buy' : 'Sell'}
            </span>
            <span role="cell" className="right" style={{ padding: '8px 10px' }}>
              {f.sol.toFixed(2)}
            </span>
            <span role="cell" className="right" style={{ padding: '8px 10px' }}>
              {num(f.sol / f.price)}
            </span>
            <span role="cell" className="right" style={{ padding: '8px 10px' }}>
              {f.price.toFixed(5)}
            </span>
            <span role="cell" className="right muted" style={{ padding: '8px 10px' }}>
              {f.round.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function TradePanel({ sim, coin }: { sim: RoundSim; coin: Coin }) {
  const st = useStore(sim.store)
  const s = useMarket()
  const [side, setSide] = useState<Side>('buy')
  const [amount, setAmount] = useState('0.5')
  const others = market.seated(s).filter((c) => c.ticker !== coin.ticker)
  const [target, setTarget] = useState(others[0]?.ticker ?? '')
  const price = priceOf(coin)
  const held = market.holding(coin.ticker, s)
  const heldValue = (held?.size ?? 0) * price
  const amt = parseFloat(amount) || 0

  const overCap = side === 'buy' && amt > OWNERSHIP_CAP_SOL
  const noFunds = side === 'buy' && amt * (1 + FEE) > s.balance
  const overHeld = side !== 'buy' && amt > heldValue + 1e-9
  const invalid = overCap || noFunds || overHeld || amt <= 0
  const closesLeft = Math.max(0, ((COLLECT_TICKS - st.t) * TICK_MS) / 1000)
  const quick = side === 'buy' ? ['0.1', '0.5', '1', '2'] : ['25%', '50%', '75%', 'Max']
  const targetCoin = others.find((c) => c.ticker === target)

  const sides: [Side, string, string, string][] = [
    ['buy', 'Buy', 'var(--green)', 'rgba(52,211,153,0.12)'],
    ['sell', 'Sell', 'var(--red)', 'rgba(251,113,133,0.12)'],
    ['switch', 'Switch', 'var(--violet)', 'var(--accent-soft)'],
  ]
  let confirmText = side === 'buy' ? `Buy $${coin.ticker}` : side === 'sell' ? `Sell $${coin.ticker}` : `Switch to $${target}`
  if (st.order) confirmText = `Queued for round ${st.roundNo.toLocaleString()}`

  const om = st.orderMsg
  const ok = om?.tag === 'Filled'
  return (
    <section aria-label="Trade" className="card">
      <div role="radiogroup" aria-label="Order side" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
        {sides.map(([id, label, c, bg]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={side === id}
            onClick={() => setSide(id)}
            style={{ padding: '9px 0', borderRadius: 6, border: `1px solid ${side === id ? c : 'var(--border-strong)'}`, background: side === id ? bg : 'transparent', color: side === id ? c : 'var(--text)', fontWeight: 700 }}
          >
            {label}
          </button>
        ))}
      </div>
      {side === 'switch' && (
        <label className="kv" style={{ alignItems: 'center', padding: '10px 12px', borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: 14 }}>
          <span className="muted">Switch ${coin.ticker} into</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="select">
            {others.map((c) => (
              <option key={c.ticker} value={c.ticker}>
                {c.name} · ${c.ticker}
              </option>
            ))}
          </select>
        </label>
      )}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {side === 'buy' ? 'You pay' : side === 'sell' ? 'You sell (in SOL value)' : 'Move (in SOL value)'}
        </span>
        <span className={'input-box' + (overCap || noFunds || overHeld ? ' invalid' : '')}>
          <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in SOL" />
          <span className="muted" style={{ fontWeight: 600 }}>
            SOL
          </span>
        </span>
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        {quick.map((q) => (
          <button
            key={q}
            type="button"
            className="pill-btn xs"
            style={{ flex: 1 }}
            onClick={() => setAmount(q.includes('%') ? ((heldValue * parseFloat(q)) / 100).toFixed(2) : q === 'Max' ? (Math.floor(heldValue * 100) / 100).toFixed(2) : q)}
          >
            {q}
          </button>
        ))}
      </div>
      <div className="tnum" style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 14 }}>
        <span className="kv">
          <span className="muted">Fee</span>
          <span>{(amt * FEE).toFixed(4)} SOL (0.3%)</span>
        </span>
        <span className="kv">
          <span className="muted">Estimated fill</span>
          <span>
            ≈ {num(amt / price)} {coin.ticker}
            {side === 'switch' && targetCoin ? ` → ${num((amt * (1 - FEE)) / priceOf(targetCoin))} ${targetCoin.ticker}` : ''}
          </span>
        </span>
        <span className="kv">
          <span className="muted">Fills next round</span>
          <span style={{ color: 'var(--violet)', fontWeight: 600 }}>{closesLeft > 0 ? `in ${closesLeft.toFixed(1)}s` : 'next round'}</span>
        </span>
      </div>
      {overCap && <div role="alert" className="alert bordered">This trade would put you over the ownership cap ({OWNERSHIP_CAP_SOL} SOL per person on this coin).</div>}
      {!overCap && noFunds && <div role="alert" className="alert bordered">Not enough SOL. Your balance is {s.balance.toFixed(2)} SOL.</div>}
      {overHeld && <div role="alert" className="alert bordered">You hold {heldValue.toFixed(2)} SOL of ${coin.ticker}.</div>}
      <button
        type="button"
        className="btn-primary"
        disabled={invalid || !!st.order || (side === 'switch' && !targetCoin)}
        onClick={() => sim.place({ side, sol: amt, target: side === 'switch' ? target : undefined })}
        style={{ padding: '13px 0', fontWeight: 800, fontSize: 16 }}
      >
        {confirmText}
      </button>
      {om && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 6, background: ok ? 'rgba(52,211,153,0.1)' : 'var(--accent-soft)', fontSize: 14 }}>
          <span key={om.tag + om.msg} className="lm-pop" style={{ color: ok ? 'var(--green)' : 'var(--violet)', fontWeight: 700 }}>
            {om.tag}
          </span>
          <span style={{ color: 'var(--text-2)' }}>{om.msg}</span>
        </div>
      )}
    </section>
  )
}

function PositionCard({ coin }: { coin: Coin }) {
  const s = useMarket()
  const h = market.holding(coin.ticker, s)
  const size = h?.size ?? 0
  const value = size * priceOf(coin)
  const pnl = value - size * (h?.entry ?? 0)
  return (
    <section aria-label="Your position" className="card" style={{ gap: 10 }}>
      <span className="card-title">Your position</span>
      <div className="tnum" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        <MiniStat label="Holding" value={`${size.toLocaleString()} ${coin.ticker}`} />
        <MiniStat label="Value" value={`${value.toFixed(2)} SOL`} />
        <MiniStat label="Unrealized" value={`${signed(pnl)} SOL`} color={pnl >= 0 ? 'var(--green)' : 'var(--red)'} />
      </div>
    </section>
  )
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span className="muted" style={{ fontSize: 13 }}>
        {label}
      </span>
      <span style={{ fontWeight: 700, color }}>{value}</span>
    </div>
  )
}

function SurvivalCard({ sim, coin }: { sim: RoundSim; coin: Coin }) {
  const st = useStore(sim.store)
  const s = useMarket()
  const low = coin.secs < 2 * 3600
  // Net time gained from rounds since this page opened (timer drains 1s/s otherwise).
  const [opened] = useState(() => ({ at: Date.now(), secs: coin.secs }))
  const now = useNow()
  const drained = Math.max(0, Math.round((now - opened.at) / 1000))
  const net = coin.secs - opened.secs
  const seated = market.seated(s)
  const avg = Math.round(seated.reduce((a, c) => a + c.people, 0) / seated.length)
  const maxPeople = Math.max(...seated.map((c) => c.people), 1)
  const showGain = st.phase === 'clear' && !!st.gainText
  return (
    <section aria-label="Survival" className={'card' + (low ? ' lm-warn' : '')}>
      <div className="kv" style={{ alignItems: 'center' }}>
        <span className="card-title">Survival timer</span>
        <span className="tnum" title={`${timeLeft(drained)} drained, ${timeLeft(Math.max(0, net + drained))} added by rounds`} style={{ color: net >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700, fontSize: 14 }}>
          {net >= 0 ? '+' : '−'}
          {timeLeft(Math.abs(net))} this visit
        </span>
      </div>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="tnum" style={{ fontFamily: 'var(--mono)', fontSize: 38, fontWeight: 300, letterSpacing: '-0.03em', lineHeight: 1, whiteSpace: 'nowrap', color: low ? 'var(--red)' : 'var(--text)' }}>
          {timeLeftLong(coin.secs)}
        </span>
        <span className="tnum green" style={{ fontWeight: 700, opacity: showGain ? 1 : 0, transition: 'opacity 0.4s ease' }}>
          {st.gainText}
        </span>
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 14 }}>
          <span style={{ fontWeight: 700 }}>{coin.people}</span> <span className="muted">people traded in the last hour</span>
        </span>
        <div aria-hidden="true" style={{ position: 'relative', height: 6, borderRadius: 6, background: 'var(--chip)' }}>
          <div style={{ height: 6, width: `${Math.min(100, (coin.people / maxPeople) * 100).toFixed(1)}%`, borderRadius: 6, background: low ? 'var(--red)' : 'var(--violet)', transition: 'width 0.6s ease' }} />
          <span style={{ position: 'absolute', top: -4, left: `${Math.min(100, (avg / maxPeople) * 100)}%`, width: 2, height: 14, background: 'var(--muted)' }} />
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          board average {avg} · each round adds time based on how many different people traded, so many small traders keep it alive and a few big wallets don't
        </span>
      </div>
      {low && <div role="alert" className="alert">If the timer hits zero, this coin is delisted at the next epoch and holders are not paid out.</div>}
    </section>
  )
}
