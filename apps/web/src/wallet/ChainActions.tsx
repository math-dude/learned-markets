import { useState } from 'react'
import { Link } from 'react-router-dom'
import { LaunchSparks } from '../pages/LaunchPage'
import { CoinTile } from '../components/CoinBits'
import { gateRequest, type Wallet } from './access'

export function ChainLaunch({ wallet, refresh }: { wallet: Wallet; refresh: () => void }) {
  const [name, setName] = useState('')
  const [ticker, setTicker] = useState('')
  const [step, setStep] = useState('')
  const [error, setError] = useState('')
  const [market, setMarket] = useState('')
  return (
    <div className="launch-layout">
      <div className="launch-preview">
        <div className="launch-orbit" aria-hidden="true" />
        <div key={market} className={'launch-token' + (market ? ' lm-grad' : '')}>
          {market && <LaunchSparks />}
          <CoinTile ticker={ticker || '?'} tint="var(--accent-soft)" size={104} />
        </div>
        <strong>{name || 'Your coin'}</strong>
        <span>${ticker || 'TICKER'}</span>
      </div>
      <section className="card launch-editor">
        {market ? (
          <div className="launch-status lm-new" role="status">
            <h2>Market opened</h2>
            <Link to={'/coin/' + market}>Trade ${ticker}</Link>
          </div>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              setError('')
              setStep('Preparing launch…')
              try {
                const r = await fetch('/api/chain/launch', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name: name.trim(), ticker }),
                  signal: AbortSignal.timeout(15_000),
                })
                const data = await r.json()
                if (!r.ok)
                  throw new Error(
                    typeof data.detail === 'string' ? data.detail : 'Launch could not be prepared.',
                  )
                setStep('Confirm launch in Privy…')
                await wallet.send(data.transactionBase64, () => setStep('Confirming on the validator…'))
                setMarket(data.market)
                refresh()
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Launch failed.')
              } finally {
                setStep('')
              }
            }}
          >
            <h2>Coin details</h2>
            <label>
              Name
              <input
                className="input-box"
                required
                minLength={2}
                maxLength={32}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Ticker
              <input
                className="input-box"
                required
                pattern="[A-Z0-9]{2,6}"
                maxLength={6}
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
              />
            </label>
            <small>Launch fee · 0.1 ledger SOL</small>
            <button className="btn-primary" disabled={!!step}>
              {step || 'Launch on Surfpool'}
            </button>
            {error && <p role="alert">{error}</p>}
          </form>
        )}
      </section>
    </div>
  )
}

export function ChainOrder({
  wallet,
  market,
  refresh,
}: {
  wallet: Wallet
  market: string
  refresh: () => void
}) {
  const [side, setSide] = useState('buy')
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [step, setStep] = useState('')
  const [note, setNote] = useState('')
  const recovery = ['lm.trade', import.meta.env.VITE_LM_NETWORK, wallet.address, market].join('.')
  const [pending, setPending] = useState(() => sessionStorage.getItem(recovery))
  async function admit(intent: string) {
    try {
      await gateRequest('intents/admit', { intent, expectedKind: 'trade', expectedTarget: market })
    } catch (err) {
      if (!(err instanceof Error && err.message === 'intent already admitted')) throw err
    }
    sessionStorage.removeItem(recovery)
    setPending(null)
    setNote('Signed order received. Your portfolio shows its clearing result.')
    refresh()
  }
  return (
    <form
      className="card paper-form"
      onSubmit={async (e) => {
        e.preventDefault()
        setNote('')
        setStep('Preparing order…')
        try {
          if (pending) await admit(pending)
          else {
            const tx = await gateRequest<{ intent: string; transactionBase64: string }>('intents/prepare', {
              kind: 'trade',
              target: market,
              trade: { side, points: [{ price, quantity }] },
            })
            setStep('Sign order in Privy…')
            await wallet.send(tx.transactionBase64, () => {
              sessionStorage.setItem(recovery, tx.intent)
              setPending(tx.intent)
              setStep('Confirming order…')
            })
            await admit(tx.intent)
          }
        } catch (err) {
          setNote(err instanceof Error ? err.message : 'Order failed.')
        } finally {
          setStep('')
        }
      }}
    >
      <h2>Limit order</h2>
      <div className="paper-tabs">
        {['buy', 'sell'].map((s) => (
          <button
            className="pill-btn"
            type="button"
            key={s}
            aria-pressed={s === side}
            disabled={!!step || !!pending}
            onClick={() => setSide(s)}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>
      <label>
        Whole tokens
        <input
          className="input-box"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          required={!pending}
          pattern="[1-9][0-9]*"
          inputMode="numeric"
          disabled={!!pending}
        />
      </label>
      <label>
        {side === 'buy' ? 'Maximum' : 'Minimum'} price (micro-lamports per token)
        <input
          className="input-box"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          required={!pending}
          pattern="[1-9][0-9]*"
          inputMode="numeric"
          disabled={!!pending}
        />
      </label>
      <button className="btn-primary" disabled={!!step}>
        {step || (pending ? 'Check signed order' : 'Submit ' + side + ' order')}
      </button>
      {note && (
        <p role="status">
          {note} <Link to="/portfolio">Portfolio</Link>
        </p>
      )}
    </form>
  )
}
