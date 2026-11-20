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
                setStep('Signing launch…')
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
  ticker = 'coin',
  marketPrice = '27970074',
  holding = '0',
  orders = [],
}: {
  wallet: Wallet
  market: string
  ticker?: string
  marketPrice?: string
  holding?: string
  orders?: { intent: string; status: string; details: string }[]
  refresh: () => void
}) {
  const [side, setSide] = useState('buy')
  const [quantity, setQuantity] = useState('')
  const [budget, setBudget] = useState('0.01')
  // Market order with slippage protection: the limit follows the live price unless the trader sets one.
  const [slippage, setSlippage] = useState(20)
  const [custom, setCustom] = useState('')
  const live = BigInt(marketPrice === '0' ? '27970074' : marketPrice)
  const auto = side === 'buy' ? (live * BigInt(100 + slippage)) / 100n : (live * BigInt(100 - slippage)) / 100n
  const price = custom || (auto > 0n ? auto : 1n).toString()
  const setPrice = setCustom
  const [step, setStep] = useState('')
  const [note, setNote] = useState('')
  // The order just placed: its clearing result is shown here as soon as the batch settles.
  const [placed, setPlaced] = useState('')
  const order = orders.find((o) => o.intent === placed)
  let outcome: { state: 'working' | 'filled' | 'missed'; text: string } | null = null
  if (placed) {
    if (order?.status === 'filled') {
      const fill = JSON.parse(order.details) as { side: string; quantity: string; clearing_price: string }
      outcome = {
        state: 'filled',
        text:
          (fill.side === 'buy' ? 'Bought ' : 'Sold ') +
          Number(fill.quantity).toLocaleString() +
          ' ' +
          ticker +
          ' at ' +
          (Number(fill.clearing_price) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 }) +
          ' lamports',
      }
    } else if (order && order.status !== 'queued' && order.status !== 'confirming')
      outcome = { state: 'missed', text: order.details || 'The order did not fill.' }
    else outcome = { state: 'working', text: order?.status === 'confirming' ? 'Settling on chain…' : 'Clearing in the next batch…' }
  }
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
    setPlaced(intent)
    refresh()
  }
  return (
    <form
      className="card paper-form"
      data-outcome={step ? 'sending' : outcome?.state}
      onSubmit={async (e) => {
        e.preventDefault()
        setNote('')
        setPlaced('')
        setStep('Placing order…')
        try {
          if (pending) await admit(pending)
          else {
            const tx = await gateRequest<{ intent: string; transactionBase64: string }>('intents/prepare', {
              kind: 'trade',
              target: market,
              trade: {
                side,
                points: [
                  {
                    price,
                    quantity:
                      side === 'buy'
                        ? (
                            (((BigInt(Math.floor(Number(budget) * 1e9)) * 1000000n) / BigInt(price)) * 100n) /
                            101n
                          ).toString()
                        : quantity,
                  },
                ],
              },
            })
            await wallet.send(tx.transactionBase64, () => {
              sessionStorage.setItem(recovery, tx.intent)
              setPending(tx.intent)
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
      <h2>Trade</h2>
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
      <label className="artifact-amount-label">
        {side === 'buy' ? 'You pay' : 'You sell'}
        <div className="artifact-amount">
          <input
            value={side === 'buy' ? budget : quantity}
            onChange={(e) => (side === 'buy' ? setBudget(e.target.value) : setQuantity(e.target.value))}
            required={!pending}
            type="number"
            min={side === 'buy' ? '0.000001' : '1'}
            step={side === 'buy' ? '0.000001' : '1'}
            disabled={!!pending}
            aria-label={side === 'buy' ? 'Amount in SOL' : 'Tokens to sell'}
          />
          <span>{side === 'buy' ? 'SOL' : ticker}</span>
        </div>
      </label>
      <div className="trade-presets">
        {(side === 'buy' ? ['0.005', '0.01', '0.025', '0.05'] : ['25', '50', '75', '100']).map((value) => (
          <button
            type="button"
            key={value}
            disabled={!!pending || !!step}
            onClick={() =>
              side === 'buy'
                ? setBudget(value)
                : setQuantity(((BigInt(holding) * BigInt(value)) / 100n).toString())
            }
          >
            {value}
            {side === 'sell' ? '%' : ''}
          </button>
        ))}
      </div>
      <div className="slippage">
        <span>{side === 'buy' ? 'Max price' : 'Min price'}</span>
        {[5, 20, 50].map((v) => (
          <button
            type="button"
            key={v}
            className="pill-btn"
            aria-pressed={!custom && slippage === v}
            onClick={() => {
              setCustom('')
              setSlippage(v)
            }}
          >
            {side === 'buy' ? '+' : '−'}
            {v}%
          </button>
        ))}
      </div>
      <details>
        <summary>Custom limit price</summary>
        <label>
          Micro-lamports per token (blank = follow the market)
          <input
            className="input-box"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            pattern="[1-9][0-9]*"
            inputMode="numeric"
            disabled={!!pending}
          />
        </label>
      </details>
      <div className="trade-estimate">
        <span>Estimated tokens</span>
        <strong>
          {side === 'buy' && Number(price) > 0
            ? Math.floor((Number(budget) * 1e15) / Number(price) / 1.01).toLocaleString()
            : Number(quantity || 0).toLocaleString()}{' '}
          {ticker}
        </strong>
      </div>
      <div className="trade-estimate">
        <span>Execution</span>
        <strong>Next clearing round</strong>
      </div>
      <button className="btn-primary" disabled={!!step}>
        {step || (pending ? 'Check signed order' : (side === 'buy' ? 'Buy $' : 'Sell $') + ticker)}
      </button>
      {outcome && (
        <p role="status" className="order-status" data-state={outcome.state} key={outcome.state}>
          <i />
          <span>{outcome.text}</span>
          {outcome.state === 'working' && <b className="order-progress" />}
        </p>
      )}
      {note && (
        <p role="status">
          {note} <Link to="/portfolio">Portfolio</Link>
        </p>
      )}
    </form>
  )
}
