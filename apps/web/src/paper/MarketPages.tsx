import { useState } from 'react'
import { Link, Outlet, useParams } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'
import { Crown } from '../components/icons'
import { ShellFrame, Search } from '../components/Shell'
import { tintFor } from '../market/tints'
import { sol, unitPrice, usePaperConnection, useRoom, type PaperCoin } from '../market/paper'
import { LaunchForm } from '../pages/LaunchPage'
import { num } from '../lib/format'
import { CandleChart } from '../pages/coin/PriceChart'
import { AccessPanel } from '../wallet/AccessPanel'
import { useWallet } from '../wallet/access'
import { useNow } from '../lib/useNow'
import '../pages/coin.css'
import '../pages/board.css'
import './paper.css'

export function PaperShell() {
  const connection = usePaperConnection()
  const { data, offline } = connection
  const wallet = useWallet()
  const [signOutError, setSignOutError] = useState('')
  const coins = (data?.coins ?? []).map(c => ({
    key: String(c.coin_id), name: c.name, ticker: c.ticker, tint: tintFor(c.coin_id),
    where: c.stage === 'line' ? 'The Line' : 'Board', to: '/coin/' + c.ticker,
  }))
  const bar = <header className="topbar">
    <Search coins={coins} />
    <span className="paper-label">{data?.access === 'solana' ? (import.meta.env.VITE_LM_NETWORK === 'devnet' ? 'Devnet' : 'Surfpool') + ' · paper trading' : 'Paper trading'}</span>
    {data?.access === 'solana' && wallet?.address && <button className="pill-btn" onClick={async () => {
      try { await wallet.logout(); window.location.reload() } catch { setSignOutError('Sign-out could not complete. Reload to check your session.') }
    }}>Sign out</button>}
    <Link to="/portfolio" className="chip chip-strong">{data?.account ? sol(data.account.cash) + ' SOL' : 'Portfolio'}</Link>
  </header>
  return <ShellFrame bar={bar}>
    {signOutError && <div role="alert">{signOutError}</div>}
    {offline && <div role="alert" className="paper-warning">Market disconnected. Reconnecting…</div>}
    {data ? <Outlet context={{ ...connection, data }} /> :
      <main className="paper-page"><h1>{offline ? 'Market unavailable' : 'Connecting to the market…'}</h1></main>}
  </ShellFrame>
}

function AccountButton() {
  const { data, post, busy, offline } = useRoom()
  const [error, setError] = useState('')
  if (data.access === 'solana') return <AccessPanel connect={() => post('session', {})} />
  return <><button className="btn-primary"  disabled={busy || offline} onClick={async () => {
    setError('')
    try { await post('session', {}) } catch (err) { setError(message(err)) }
  }}>Open paper account · 2 SOL</button>{error && <span role="alert">{error}</span>}</>
}

const message = (error: unknown) => error instanceof Error ? error.message : 'Request failed.'
const stage = (coin: PaperCoin) => coin.stage === 'line' ? 'Line' : coin.stage === 'rookie' ? 'Rookie' : 'Regular'

function CoinRow({ coin, detail }: { coin: PaperCoin; detail: string }) {
  return <Link className="paper-row" to={'/coin/' + coin.ticker}>
    <CoinTile ticker={coin.ticker} tint={tintFor(coin.coin_id)} size={48} />
    <span className="paper-row-name"><strong>{coin.name}</strong><small>${coin.ticker} · {stage(coin)}</small></span>
    <span className="tnum">{detail}</span>
  </Link>
}

export function PaperBoard() {
  const { data } = useRoom()
  const seated = data.coins.filter(c => c.stage !== 'line').sort((a, b) => b.price - a.price || a.coin_id - b.coin_id)
  const line = data.coins.filter(c => c.stage === 'line').sort((a, b) => b.heat - a.heat)
  const king = seated[0]
  const now = useNow()
  return <main>
    <section className="epoch-hero paper-hero">
      {king ? <Link className="paper-king" to={'/coin/' + king.ticker}>
        <CoinTile ticker={king.ticker} tint="#2D2A24" size={80}><span className="paper-crown"><Crown /></span></CoinTile>
        <span><small className="gold">#1 · king of the hill</small><strong>{king.name}</strong>
          <small>{unitPrice(king.price)} lamports / token</small></span>
      </Link> : <h2>Seats are open</h2>}
      <div><span className="eyebrow">Open batch</span><div className="epoch-clock">{data.batch_id}</div><small>Closes in {Math.max(0, Math.ceil(data.closes_at - now / 1000))}s</small></div>
      <div className="paper-stat"><strong>{data.epoch_batches - data.batch_id % data.epoch_batches}</strong><small>batches to next epoch</small></div>
    </section>
    <div className="headlines"><div className="headlines-label">Last fill</div>
      <span className="paper-tape">{data.trades[0] ? `$${data.trades[0].ticker} · ${num(data.trades[0].quantity)} tokens at ${unitPrice(data.trades[0].price)} lamports` : 'Waiting for the first trade'}</span></div>
    <div className="paper-grid">
      <section className="panel"><div className="panel-head"><h1>Board</h1><span className="muted">Market cap · SOL</span></div>
        {seated.map(c => <CoinRow key={c.coin_id} coin={c} detail={num(c.price * (data.supply / 1e15)) + ' SOL'} />)}
        {!seated.length && <p className="paper-empty">Coins earn a rookie seat at an epoch.</p>}
      </section>
      <section className="panel"><div className="panel-head"><h2>The Line</h2><Link to="/launch">Launch a meme</Link></div>
        {line.map(c => <CoinRow key={c.coin_id} coin={c} detail={'Heat ' + c.heat.toFixed(1)} />)}
        {!line.length && <p className="paper-empty">The Line is open for launches.</p>}
      </section>
    </div>
  </main>
}

export function PaperCoinPage() {
  const { data } = useRoom()
  const { ticker = '' } = useParams()
  const coin = data.coins.find(c => c.ticker === ticker.toUpperCase())
  if (!coin) return <main className="paper-page"><h1>Coin unavailable</h1><Link to="/">Return to the Board</Link></main>
  const trades = data.trades.filter(t => t.coin_id === coin.coin_id)
  const batches = new Map<number, { o: number; h: number; l: number; c: number; v: number }>()
  for (const trade of [...trades].reverse()) {
    const price = trade.price / 1e6
    const candle = batches.get(trade.batch_id) ?? { o: price, h: price, l: price, c: price, v: 0 }
    candle.v += trade.quantity
    batches.set(trade.batch_id, candle)
  }
  const batchIds = [...batches.keys()]
  return <main className="paper-page">
    <Link to="/">← Board</Link>
    <header className="paper-coin-head"><CoinTile tint={tintFor(coin.coin_id)} ticker={coin.ticker} />
      <div><span className="badge badge-outline">{stage(coin)}</span><h1>{coin.name}</h1>
        <strong className="tnum">{unitPrice(coin.price)} lamports / token</strong></div></header>
    <div className="paper-grid">
      <div className="paper-history"><CandleChart candles={[...batches.values()]} price={coin.price / 1e6}
        ticker={coin.ticker} unit="lamports" caption={i => 'Batch ' + batchIds[i]} />
      <section className="panel"><div className="panel-head"><h2>Recent fills</h2><small>Cleared batches</small></div>
        {trades.map((t, i) => <div className="paper-row" key={i}><span>Batch {t.batch_id}</span>
          <strong className={t.side === 'buy' ? 'green' : 'red'}>{t.side} {num(t.quantity)}</strong>
          <span>{unitPrice(t.price)} lamports / token</span></div>)}
        {!trades.length && <p className="paper-empty">No recent fills for this coin.</p>}
      </section>
      </div>
      <TradeTicket key={coin.coin_id} coin={coin} />
    </div>
    <section className="card"><h2>Batch {data.batch_id} terms</h2>
      <p>Position cap {num(coin.cap_tokens)} tokens · Base fee {data.base_fee_bps / 100}% · Early exit fee {(100 * coin.early_exit_fee).toFixed(2)}% · Half-life {coin.hold_half_life_batches.toFixed(1)} batches · Size fee {(100 * coin.size_fee_per_pct_supply).toFixed(2)}% per 1% of supply</p>
      <small>Reserve {sol(coin.reserve_cash)} SOL · {num(coin.holders)} holders</small>
      <details><summary>Quoter commitment</summary><code>{data.commitment}</code></details>
    </section>
  </main>
}

function TradeTicket({ coin }: { coin: PaperCoin }) {
  const { data, post, busy, offline } = useRoom()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [quantity, setQuantity] = useState('100000')
  const [limit, setLimit] = useState((coin.price / 1e6).toString())
  const [feedback, setFeedback] = useState('')
  const pending = data.account?.pending_coins.includes(coin.coin_id)
  const price = Math.round(Number(limit) * 1e6)
  const qty = Number(quantity)
  const held = data.account?.positions[coin.coin_id] ?? 0
  const valid = /^\d+(\.\d{1,6})?$/.test(limit) && Number.isSafeInteger(price) && price > 0
    && /^\d+$/.test(quantity) && Number.isSafeInteger(qty) && qty > 0 && qty <= data.supply
  const receipt = data.account?.receipts.find(r => r.kind === 'order' && r.ticker === coin.ticker)
  return <form className="card paper-form" onSubmit={async e => {
    e.preventDefault()
    if (!valid || busy || offline || pending) return
    setFeedback('')
    try {
      await post('orders', { coin_id: coin.coin_id, batch_id: data.batch_id, side, limit_price: price, quantity: qty })
    } catch (err) { setFeedback(message(err)) }
  }}>
    <h2>Trade ${coin.ticker}</h2>
    <div className="paper-tabs">{(['buy', 'sell'] as const).map(s =>
      <button type="button" className="pill-btn" aria-pressed={side === s} key={s} onClick={() => {setSide(s); setFeedback('')}}>{s === 'buy' ? 'Buy' : 'Sell'}</button>)}</div>
    <label>Whole tokens<span className="input-box"><input inputMode="numeric" value={quantity} onChange={e => setQuantity(e.target.value)} /></span></label>
    <label>{side === 'buy' ? 'Maximum' : 'Minimum'} price · lamports per token
      <span className="input-box"><input inputMode="decimal" value={limit} onChange={e => setLimit(e.target.value)} /></span></label>
    <small>Your position · {num(held)} tokens</small>
    {data.account ? <button className="btn-primary" type="submit" disabled={!valid || busy || offline || pending}>
      {pending ? 'Order queued' : 'Submit ' + side + ' order'}</button> : <Link to="/portfolio">Open a paper account to trade</Link>}
    {pending && <span role="status">Queued for batch {data.batch_id}</span>}
    {receipt?.kind === 'order' && <span role="status">Batch {receipt.batch_id} · {num(receipt.quantity)} tokens filled</span>}
    {feedback && <span role="alert" className="red">{feedback}</span>}
  </form>
}

export function PaperPortfolio() {
  const { data } = useRoom()
  const account = data.account
  if (!account) return <main className="paper-page"><h1>Portfolio</h1><section className="card">
    <h2>Start paper trading</h2><p>Your demo balance and positions follow this browser until the auctioneer restarts.</p><AccountButton />
  </section></main>
  const held = data.coins.filter(c => account.positions[c.coin_id] > 0)
  return <main className="paper-page"><h1>Portfolio</h1>
    <div className="card paper-balance"><small>Available paper balance</small><strong>{sol(account.cash)} SOL</strong></div>
    <section className="panel"><div className="panel-head"><h2>Positions</h2></div>
      {held.map(c => <CoinRow key={c.coin_id} coin={c} detail={num(account.positions[c.coin_id]) + ' tokens'} />)}
      {!held.length && <p className="paper-empty">You don’t hold any coins yet. <Link to="/">Explore the Board</Link></p>}</section>
    <section className="panel"><div className="panel-head"><h2>Activity</h2></div>
      {account.pending_launch && <p className="paper-empty">Launch queued · ${account.pending_launch}</p>}
      {data.coins.filter(c => account.pending_coins.includes(c.coin_id)).map(c => <p className="paper-empty" key={c.coin_id}>Order queued · ${c.ticker}</p>)}
      {account.receipts.map((r, i) => <div className="paper-row" key={i}><span>Batch {r.batch_id}</span><strong>${r.ticker}</strong>
        <span>{r.kind === 'order' ? r.side + ' · ' + num(r.quantity) + ' tokens filled · fee ' + sol(r.fee) + ' SOL' : r.opened ? 'Joined the Line' : 'Launch declined'}</span></div>)}
      {!account.receipts.length && !account.pending_launch && !account.pending_coins.length && <p className="paper-empty">Your orders and launches will appear here.</p>}
    </section></main>
}

export function PaperLaunch() {
  const { data, busy, offline, post } = useRoom()
  if (!data.account) return <main className="paper-page"><h1>Launch a meme</h1><AccountButton /></main>
  return <LaunchForm tickers={data.coins.map(c => c.ticker)} disabled={busy || offline || !!data.account.pending_launch}
    detail={'Launch fee ' + sol(data.launch_fee) + ' paper SOL. Accepted launches join the Line when the batch clears.'}
    submit={async (name, ticker) => {
      const result = await post('launches', { name, ticker, batch_id: data.batch_id })
      return '$' + ticker + ' queued for batch ' + result.batch_id + '.'
    }} />
}

export function PaperGuide() {
  const { data } = useRoom()
  return <main className="paper-page"><h1>How it works</h1>
    <section className="card"><h2>Trading rounds</h2><p>Submit a quantity and a limit price. The auctioneer clears a batch at one price per coin. An order can fill fully, partially, or for zero tokens. Portfolio shows the result.</p></section>
    <section className="card"><h2>Line and Board</h2><p>New coins enter the Line and can trade there. Activity adds heat. Every {data.epoch_batches} batches, eligible Line coins compete for rookie seats. Sustained activity earns graduation. Low heat or an expired survival timer can end a coin.</p></section>
    <section className="card"><h2>Published terms</h2><p>Each coin shows the current position cap and exit terms. The quoter commits its curve before orders arrive. Your receipt and balances update after clearing.</p></section>
    <Link to="/">Go to the Board</Link></main>
}
