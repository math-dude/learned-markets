import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CoinTile, RookieBadge } from '../components/CoinBits'
import { signed, signedPct, timeLeft } from '../lib/format'
import { market, useMarket } from '../market/engine'
import { STATUS_COLORS, priceOf } from '../market/seed'

const LOW = 2 * 3600

export function PortfolioPage() {
  const s = useMarket()

  const rows = s.holdings
    .map((h) => {
      const coin = market.findCoin(h.ticker, s)
      if (!coin) return null
      const price = priceOf(coin)
      const value = h.size * price
      const cost = h.size * h.entry
      return { h, coin, price, value, cost, pnl: value - cost }
    })
    .filter((r) => r !== null)
    .sort((a, b) => a.coin.secs - b.coin.secs)

  const totalValue = rows.reduce((a, r) => a + r.value, 0)
  const totalPnl = rows.reduce((a, r) => a + r.pnl, 0)
  const shownValue = useTween(totalValue)
  const risk = rows.find((r) => r.coin.secs < LOW)

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 18, padding: 20 }}>
      <section aria-label="Summary" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 14 }}>
        <BalanceCard />
        <SummaryCard label="In coins" value={shownValue.toFixed(2)} unit="SOL" sub={`${rows.length} coins held`} />
        <SummaryCard label="Unrealized" value={signed(totalPnl)} unit="SOL" sub="across open positions" color={totalPnl >= 0 ? 'var(--green)' : 'var(--red)'} />
        <SummaryCard label="Your picks survived" value={`${s.streak} epochs`} sub="in a row, no coin you held died" color="var(--violet-hi)" />
      </section>

      {rows.length === 0 ? (
        <section aria-label="No positions" className="card" style={{ padding: '48px 20px', alignItems: 'center', gap: 14, textAlign: 'center' }}>
          <span style={{ fontSize: 20, fontWeight: 700 }}>You don't hold any coins yet</span>
          <span className="muted" style={{ maxWidth: 420, lineHeight: 1.45 }}>
            Pick a seated coin on the Board. If it keeps trading with lots of different people, it survives each epoch.
          </span>
          <Link to="/" className="btn-primary" style={{ padding: '11px 22px' }}>
            Go to the Board
          </Link>
        </section>
      ) : (
        <>
          {risk && (
            <section aria-label="At risk" className="lm-warn" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 6, background: 'rgba(251,113,133,0.08)' }}>
              <span className="red" style={{ fontWeight: 700 }}>
                At risk
              </span>
              <span style={{ color: 'var(--red-soft)' }}>
                {risk.coin.name} has {timeLeft(risk.coin.secs)} left. If its timer is at zero at an epoch, it dies and your {risk.value.toFixed(3)} SOL in it is gone.
              </span>
              <Link to={`/coin/${risk.coin.ticker}`} style={{ marginLeft: 'auto', fontWeight: 600 }}>
                Open coin
              </Link>
            </section>
          )}
          <section aria-label="Positions" className="panel">
            <div className="panel-head">
              <span className="section-title">Positions</span>
              <span className="muted" style={{ fontSize: 13 }}>
                sorted by time left
              </span>
            </div>
            <div className="table-scroll">
              <div role="table" aria-label="Positions" style={{ minWidth: 900 }}>
                <div role="row" className="grid-row grid-head pos-cols">
                  {['Coin', 'Size', 'Entry', 'Price', 'Value', 'Unrealized', 'Timer', ''].map((h, i) => (
                    <span role="columnheader" key={i} className={i > 0 && i < 7 ? 'right' : ''} style={{ padding: '8px 0' }}>
                      {h}
                    </span>
                  ))}
                </div>
                {rows.map(({ h, coin, price, value, cost, pnl }) => {
                  const low = coin.secs < LOW
                  const fl = coin.flash // set by the engine for ~1s after each trade
                  const flashBg = fl === 'up' ? 'rgba(52,211,153,0.10)' : fl === 'down' ? 'rgba(251,113,133,0.10)' : 'transparent'
                  const life = coin.secs < LOW ? 'var(--red)' : coin.secs < 2 * LOW ? 'var(--gold)' : '#52525B'
                  return (
                    <div role="row" key={h.ticker} className="grid-row pos-cols" style={{ borderBottom: '1px solid var(--border-soft)', background: low ? 'rgba(251,113,133,0.05)' : 'transparent' }}>
                      <span role="cell" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', minWidth: 0 }}>
                        <CoinTile tint={coin.tint} ticker={coin.ticker} size={44} />
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Link to={`/coin/${coin.ticker}`} className="ellipsis" style={{ fontWeight: 600, color: 'var(--text)' }}>
                              {coin.name}
                            </Link>
                            {coin.grad !== null && <RookieBadge compact />}
                          </span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                            <span className="muted">${coin.ticker}</span>
                            <span style={{ color: STATUS_COLORS[coin.status], fontWeight: 700 }}>{coin.status}</span>
                          </span>
                        </span>
                      </span>
                      <span role="cell" className="right">
                        {h.size.toLocaleString()}
                      </span>
                      <span role="cell" className="right muted">
                        {h.entry.toFixed(5)}
                      </span>
                      <span role="cell" className="right">
                        {price.toFixed(5)}
                      </span>
                      <span role="cell" className="flash-cell" style={{ fontWeight: 600, background: flashBg }}>
                        {value.toFixed(3)} SOL
                      </span>
                      <span role="cell" className="flash-cell" style={{ fontWeight: 600, color: pnl >= 0 ? 'var(--green)' : 'var(--red)', background: flashBg }}>
                        {signed(pnl, 3)} <span style={{ fontWeight: 400 }}>({signedPct((pnl / cost) * 100)})</span>
                      </span>
                      <span role="cell" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                        <span style={{ color: low ? 'var(--red)' : 'var(--text)', fontWeight: low ? 700 : 400 }}>{timeLeft(coin.secs)}</span>
                        <span aria-hidden="true" style={{ width: 64, height: 3, borderRadius: 6, background: 'var(--border)', overflow: 'hidden' }}>
                          <span style={{ display: 'block', height: 3, width: `${Math.min(100, (coin.secs / (12 * 3600)) * 100).toFixed(1)}%`, borderRadius: 6, background: life, transition: 'width 0.9s linear, background 0.6s ease' }} />
                        </span>
                      </span>
                      <span role="cell" className="right">
                        <Link to={`/coin/${coin.ticker}`} className="pill-btn xs" style={{ display: 'inline-block', color: 'var(--text)' }}>
                          Trade
                        </Link>
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        </>
      )}

      <section aria-label="Past coins" className="panel">
        <div className="panel-head">
          <span className="section-title">Past coins</span>
          <span className="muted" style={{ fontSize: 13 }}>
            coins you held when they died · holders are not paid out
          </span>
        </div>
        <div className="table-scroll">
          <div role="table" aria-label="Past coins" style={{ minWidth: 700 }}>
            <div role="row" className="grid-row grid-head past-cols">
              {['Coin', 'Size', 'You put in', 'Lost', 'Died'].map((h, i) => (
                <span role="columnheader" key={h} className={i > 0 ? 'right' : ''} style={{ padding: '8px 0' }}>
                  {h}
                </span>
              ))}
            </div>
            {s.past.length === 0 && (
              <p className="muted" style={{ padding: '12px 16px', margin: 0 }}>
                None yet. Every coin you held has survived.
              </p>
            )}
            {s.past.map((d, i) => (
              <div role="row" key={d.ticker + i} className="grid-row past-cols muted" style={{ borderBottom: '1px solid var(--border-soft)' }}>
                <span role="cell" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
                  <CoinTile tint={d.tint} ticker={d.ticker} size={36} fontSize={11} style={{ filter: 'grayscale(1)', opacity: 0.6 }} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ color: '#D4D4D8', fontWeight: 600, textDecoration: 'line-through', textDecorationColor: '#52525B' }}>{d.name}</span>
                    <span style={{ fontSize: 13 }}>${d.ticker}</span>
                  </span>
                </span>
                <span role="cell" className="right">
                  {d.size.toLocaleString()}
                </span>
                <span role="cell" className="right">
                  {d.put.toFixed(2)} SOL
                </span>
                <span role="cell" className="right red" style={{ fontWeight: 600 }}>
                  −{d.put.toFixed(2)} SOL
                </span>
                <span role="cell" className="right">
                  {d.died}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}

function SummaryCard({ label, value, unit, sub, color }: { label: string; value: string; unit?: string; sub: string; color?: string }) {
  return (
    <div className="card" style={{ flex: '1 1 200px', padding: 16, gap: 8 }}>
      <span className="muted" style={{ fontSize: 13 }}>
        {label}
      </span>
      <span className="tnum" style={{ fontSize: 30, fontWeight: 800, color }}>
        {value}{' '}
        {unit && <span style={{ fontSize: 16, color: color ?? 'var(--muted)', fontWeight: 600 }}>{unit}</span>}
      </span>
      <span className="muted" style={{ fontSize: 14 }}>
        {sub}
      </span>
    </div>
  )
}

function BalanceCard() {
  const s = useMarket()
  const [moving, setMoving] = useState<'deposit' | 'withdraw' | null>(null)
  const [amt, setAmt] = useState('1')
  const [msg, setMsg] = useState('')
  const n = parseFloat(amt) || 0
  const error = moving === 'withdraw' && n > s.balance
  const label = moving === 'withdraw' ? 'Withdraw' : 'Deposit'

  useEffect(() => {
    if (!msg) return
    const id = setTimeout(() => setMsg(''), 4000)
    return () => clearTimeout(id)
  }, [msg])

  const confirm = () => {
    const ok = moving === 'deposit' ? market.deposit(n) : market.withdraw(n)
    if (!ok) return
    setMsg(`${moving === 'deposit' ? 'Deposited' : 'Withdrew'} ${n} SOL`)
    setMoving(null)
  }

  return (
    <div className="card" style={{ flex: '1 1 320px', padding: 16 }}>
      <span className="muted" style={{ fontSize: 13 }}>
        Balance
      </span>
      <span className="tnum" style={{ fontSize: 30, fontWeight: 800 }}>
        {s.balance.toFixed(2)} <span className="muted" style={{ fontSize: 16, fontWeight: 600 }}>SOL</span>
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn-primary" style={{ flex: 1 }} aria-pressed={moving === 'deposit'} onClick={() => { setMoving('deposit'); setMsg('') }}>
          Deposit
        </button>
        <button type="button" className="btn-ghost" style={{ flex: 1 }} aria-pressed={moving === 'withdraw'} onClick={() => { setMoving('withdraw'); setMsg('') }}>
          Withdraw
        </button>
      </div>
      {moving && (
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}
          onSubmit={(e) => {
            e.preventDefault()
            confirm()
          }}
        >
          <span className={'input-box' + (error ? ' invalid' : '')} style={{ padding: '9px 12px' }}>
            <input type="text" inputMode="decimal" autoFocus value={amt} onChange={(e) => setAmt(e.target.value)} aria-label={`${label} amount`} style={{ fontSize: 18 }} />
            <span className="muted" style={{ fontWeight: 600 }}>
              SOL
            </span>
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn-primary" disabled={error || n <= 0} style={{ flex: 1, padding: '9px 0' }}>
              {label} {amt} SOL
            </button>
            <button type="button" className="btn-ghost" style={{ padding: '9px 14px', color: 'var(--muted)', fontWeight: 400 }} onClick={() => setMoving(null)}>
              Cancel
            </button>
          </div>
          {error && (
            <span role="alert" className="red" style={{ fontSize: 13 }}>
              You can withdraw at most {s.balance.toFixed(2)} SOL.
            </span>
          )}
        </form>
      )}
      {msg && (
        <span role="status" className="lm-pop green" style={{ fontSize: 14, fontWeight: 600 }}>
          {msg}
        </span>
      )}
    </div>
  )
}

/** Ease a number toward its target (the "In coins" total glides instead of jumping). */
function useTween(target: number): number {
  const [shown, setShown] = useState(target)
  const ref = useRef(shown)
  useEffect(() => {
    const id = setInterval(() => {
      const cur = ref.current
      if (Math.abs(target - cur) < 0.0005) {
        if (cur !== target) setShown((ref.current = target))
        return
      }
      setShown((ref.current = cur + (target - cur) * 0.25))
    }, 50)
    return () => clearInterval(id)
  }, [target])
  return shown
}
