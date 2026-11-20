import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'

export function LaunchForm({ tickers, submit, disabled = false, detail }: {
  tickers: string[]; submit: (name: string, ticker: string) => Promise<string> | string; disabled?: boolean; detail?: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [ticker, setTicker] = useState('')
  const [done, setDone] = useState<string | null>(null)

  const t = ticker.trim().toUpperCase()
  const taken = tickers.includes(t)
  const tickerOk = /^[A-Z0-9]{2,6}$/.test(t)
  const valid = name.trim().length >= 2 && tickerOk && !taken && !disabled && !busy

  return (
    <main style={{ flex: 1, padding: 20, display: 'flex', justifyContent: 'center' }}>
      <form
        className="card"
        style={{ width: '100%', maxWidth: 480, alignSelf: 'flex-start', padding: 20, gap: 16 }}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!valid) return
          setBusy(true)
          setError('')
          setDone(null)
          try {
            setDone(await submit(name.trim(), t))
            setName('')
            setTicker('')
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Launch request failed.')
          } finally {
            setBusy(false)
          }
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>Launch a meme</h1>
        <span className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          {detail ?? "Your coin joins the Line. It can earn a seat at an epoch."}
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
            <input aria-label="Ticker" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} maxLength={6} placeholder="DOG" style={{ fontSize: 16 }} />
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
        {error && <p className="red" role="alert">{error}</p>}
        {done && (
          <span role="status" className="lm-pop green" style={{ fontWeight: 600 }}>
            {done} <Link to="/">See it on the Board</Link>
          </span>
        )}
      </form>
    </main>
  )
}
