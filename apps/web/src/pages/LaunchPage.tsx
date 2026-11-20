import { useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'

const sparks = [
  ['-34px', '-18px', '#FBBF24'], ['30px', '-22px', '#C084FC'],
  ['-28px', '16px', '#C084FC'], ['36px', '14px', '#FBBF24'],
  ['0px', '-30px', '#FBBF24'], ['4px', '26px', '#7C3AED'],
]

export function LaunchSparks() {
  return sparks.map(([dx, dy, background]) => <i key={dx} aria-hidden="true" className="lm-spark" style={{ '--dx':dx, '--dy':dy, background } as CSSProperties} />)
}

export function LaunchForm({ tickers, submit, disabled = false, detail, receipts }: {
  tickers: string[]; submit: (name: string, ticker: string) => Promise<number>
  disabled?: boolean; detail: string
  receipts: { ticker: string; batch_id: number; kind: string; opened?: boolean }[]
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [ticker, setTicker] = useState('')
  const [ticket, setTicket] = useState<{ name: string; ticker: string; batch: number } | null>(null)
  const receipt = ticket && receipts.find(r => r.kind === 'launch' && r.ticker === ticket.ticker && r.batch_id === ticket.batch)
  const t = ticker.trim().toUpperCase()
  const taken = tickers.includes(t)
  const tickerOk = /^[A-Z0-9]{2,6}$/.test(t)
  const valid = name.trim().length >= 2 && tickerOk && !taken && !disabled && !busy
  return <main className="launch-page">
    <header><span className="eyebrow">The Line</span><h1>Launch a meme</h1></header>
    <div className="launch-layout">
      <div className="launch-preview">
        <div className="launch-orbit" aria-hidden="true" />
        <div key={receipt?.opened ? 'opened' : 'draft'} className={'launch-token' + (receipt?.opened ? ' lm-grad' : '')}>
          <CoinTile size={104} tint="var(--accent-soft)" ticker={ticket?.ticker || t || '?'} />
          {receipt?.opened && <LaunchSparks/>}
        </div>
        <strong>{ticket?.name || name.trim() || 'Your coin'}</strong>
        <span>${ticket?.ticker || t || 'TICKER'}</span>
      </div>
      <section className="card launch-editor">
        {ticket ? <>
          <div role="status" key={receipt ? 'receipt' : 'queued'} className="launch-status lm-pop">
            <small>Batch {ticket.batch}</small>
            <h2>{receipt ? receipt.opened ? 'Joined the Line' : 'Launch declined' : 'Launch queued'}</h2>
            <p>{receipt ? '$' + ticket.ticker + (receipt.opened ? ' is open for paper trading.' : ' did not open in this batch.') : '$' + ticket.ticker + ' queued for batch ' + ticket.batch + '.'}</p>
          </div>
          {receipt?.opened && <Link className="btn-primary launch-link" to={'/coin/' + ticket.ticker}>View ${ticket.ticker}</Link>}
          <Link to="/">See it on the Board</Link>
          {receipt && <button className="pill-btn" onClick={() => setTicket(null)}>Create another coin</button>}
        </> : <form onSubmit={async e => {
          e.preventDefault()
          if (!valid) return
          setBusy(true); setError('')
          try {
            const batch = await submit(name.trim(), t)
            setTicket({ name: name.trim(), ticker: t, batch })
            setName(''); setTicker('')
          } catch (err) { setError(err instanceof Error ? err.message : 'Launch request failed.') }
          finally { setBusy(false) }
        }}>
          <h2>Coin details</h2>
          <label>Name<span className="input-box"><input value={name} onChange={e => setName(e.target.value)} maxLength={32} placeholder="Dog in Hat" /></span></label>
          <label>Ticker<span className={'input-box' + (t && (!tickerOk || taken) ? ' invalid' : '')}><span>$</span><input aria-label="Ticker" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} maxLength={6} placeholder="DOG" /></span></label>
          {t && !tickerOk && <span role="alert" className="red">Use 2–6 letters or numbers.</span>}
          {taken && <span role="alert" className="red">${t} is already taken.</span>}
          <p>{detail}</p>
          <button className="btn-primary" disabled={!valid}>{busy ? 'Submitting launch…' : 'Launch into the Line'}</button>
          {error && <p className="red" role="alert">{error}</p>}
        </form>}
      </section>
    </div>
  </main>
}
