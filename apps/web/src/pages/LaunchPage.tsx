import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'
import { market, useMarket } from '../market/engine'

export function LaunchPage() {
  const s = useMarket()
  const [name, setName] = useState('')
  const [ticker, setTicker] = useState('')
  const [done, setDone] = useState<string | null>(null)

  const t = ticker.trim().toUpperCase()
  const taken = !!t && (market.seated(s).some((c) => c.ticker === t) || s.line.some((l) => l.ticker === t))
  const tickerOk = /^[A-Z0-9]{2,6}$/.test(t)
  const valid = name.trim().length >= 2 && tickerOk && !taken

  return (
    <main style={{ flex: 1, padding: 20, display: 'flex', justifyContent: 'center' }}>
      <form
        className="card"
        style={{ width: '100%', maxWidth: 480, alignSelf: 'flex-start', padding: 20, gap: 16 }}
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid) return
          market.launch(name.trim(), t)
          setDone(name.trim())
          setName('')
          setTicker('')
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>Launch a meme</h1>
        <span className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          Your coin joins the Line. It gets seated on the Board at an epoch once it's the hottest coin waiting.
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <CoinTile tint="var(--accent-soft)" ticker={t || '?'} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontWeight: 700, fontSize: 18 }}>{name.trim() || 'Your coin'}</span>
            <span className="muted">${t || 'TICKER'}</span>
          </span>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            Name
          </span>
          <span className="input-box">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Dog in Hat" style={{ fontSize: 16 }} />
          </span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            Ticker
          </span>
          <span className={'input-box' + (t && (!tickerOk || taken) ? ' invalid' : '')}>
            <span className="muted">$</span>
            <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} maxLength={6} placeholder="DOG" style={{ fontSize: 16 }} />
          </span>
          {t && !tickerOk && (
            <span role="alert" className="red" style={{ fontSize: 13 }}>
              2–6 letters or numbers.
            </span>
          )}
          {taken && (
            <span role="alert" className="red" style={{ fontSize: 13 }}>
              ${t} is already taken.
            </span>
          )}
        </label>
        <button type="submit" className="btn-primary" disabled={!valid} style={{ padding: '13px 0', fontSize: 16, fontWeight: 800 }}>
          Launch into the Line
        </button>
        {done && (
          <span role="status" className="lm-pop green" style={{ fontWeight: 600 }}>
            {done} joined the Line. <Link to="/line">See it</Link>
          </span>
        )}
      </form>
    </main>
  )
}
