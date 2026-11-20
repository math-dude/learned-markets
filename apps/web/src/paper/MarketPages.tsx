import { useState } from 'react'
import { Link, Outlet, useParams } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'
import { Crown, PersonIcon, UpArrowIcon } from '../components/icons'
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
  const [sort, setSort] = useState('Market cap')
  const visible = sort === 'Rookies' ? seated.filter(c => c.stage === 'rookie') : [...seated]
  if (sort === 'Holders') visible.sort((a, b) => b.holders - a.holders)
  const king = seated[0]
  const now = useNow()
  const seconds = Math.max(0, Math.ceil(data.closes_at - now / 1000))
  return <main className="market-board">
    <section className="epoch-hero paper-hero">
      {king ? <Link className="paper-king" to={'/coin/' + king.ticker}>
        <CoinTile ticker={king.ticker} tint="#2D2A24" size={80}><span className="paper-crown"><Crown /></span></CoinTile>
        <span><small className="gold">#1 · king of the hill</small><strong>{king.name}</strong>
          <small>{unitPrice(king.price)} lamports / token</small></span>
      </Link> : <h2>Seats are open</h2>}
      <div><span className="eyebrow">Open batch</span><div className="epoch-clock">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</div>
        <div className="epoch-segments" aria-label="Epoch progress">{Array.from({length: data.epoch_batches}, (_, i) =>
          <i key={i} className={i <= data.batch_id % data.epoch_batches ? 'lit' : ''} />)}</div>
        <small>Batch {data.batch_id} · {data.epoch_batches - data.batch_id % data.epoch_batches} to epoch</small></div>
      <div className="hero-counts"><div><strong>{seated.length}</strong><small>seated</small></div>
        <div><strong className="gold">{seated.filter(c => c.stage === 'rookie').length}</strong><small>rookies</small></div>
        <div><strong>{line.length}</strong><small>in the Line</small></div></div>
    </section>
    <div className="headlines"><div className="headlines-label">Last fill</div>
      <span className="paper-tape">{data.trades[0] ? `$${data.trades[0].ticker} · ${num(data.trades[0].quantity)} tokens at ${unitPrice(data.trades[0].price)} lamports` : 'Waiting for the first trade'}</span></div>
    <div className="paper-grid">
      <section className="board-list"><div className="panel-head"><h1 className="section-title">Board</h1></div>
        <div className="board-filters">{['Market cap', 'Holders', 'Rookies'].map(key =>
          <button key={key} className="pill-btn" aria-pressed={sort === key} onClick={() => setSort(key)}>{key}</button>)}</div>
        {visible.map(c => <Link key={c.coin_id} className="board-row connected-row" to={'/coin/' + c.ticker}>
          <span className="board-rank">#{seated.indexOf(c) + 1}</span>
          <CoinTile tint={tintFor(c.coin_id)} ticker={c.ticker} />
          <div className="board-identity"><strong>{c.name}</strong><small>${c.ticker}</small>
            <span><PersonIcon /> {num(c.holders)} holders</span></div>
          <div className="board-numbers"><span className={c.stage === 'rookie' ? 'badge badge-rookie' : 'badge badge-outline'}>
            {c.stage === 'rookie' && <UpArrowIcon />}{stage(c)}</span>
            <strong>{(c.price * (data.supply / 1e15)).toLocaleString('en-US', {maximumFractionDigits: 2})} SOL</strong><small>Market cap</small></div>
        </Link>)}
        {!!seated.length && !visible.length && <p className="paper-empty">No rookies on the Board.</p>}
        {!seated.length && <p className="paper-empty">Coins earn a rookie seat at an epoch.</p>}
      </section>
      <section className="board-line"><div className="panel-head"><h2 className="section-title">The Line</h2><Link to="/launch">Launch a meme</Link></div>
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
      <aside className="coin-sidebar"><TradeTicket key={coin.coin_id} coin={coin} />
    <section className="card"><h2>Batch {data.batch_id} terms</h2>
      <dl className="coin-terms">{[
        ['Position cap', num(coin.cap_tokens) + ' tokens'], ['Base fee', data.base_fee_bps / 100 + '%'],
        ['Early exit fee', (100 * coin.early_exit_fee).toFixed(2) + '%'], ['Hold half-life', coin.hold_half_life_batches.toFixed(1) + ' batches'],
        ['Size fee per 1% of supply', (100 * coin.size_fee_per_pct_supply).toFixed(2) + '%'],
        ['Reserve', sol(coin.reserve_cash) + ' SOL'], ['Holders', num(coin.holders)],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <details><summary>Quoter commitment</summary><code>{data.commitment}</code></details>
    </section></aside></div>
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
  if (!account) return <main className="paper-page portfolio-entry"><h1>Portfolio</h1><section className="card account-entry">
    <h2>Start paper trading</h2><p>{data.access === 'solana' ? 'Verify your wallet to open a paper account. Your portfolio tracks fills as each batch clears.' : 'Open a demo account to launch coins and trade with paper SOL.'}</p><AccountButton />
  </section></main>
  const held = data.coins.filter(c => account.positions[c.coin_id] > 0)
  return <main className="paper-page"><h1>Portfolio</h1>
    <section className="portfolio-summary"><div className="card paper-balance"><small>Available paper balance</small><strong>{sol(account.cash)} SOL</strong></div>
      <div className="card paper-balance"><small>In coins</small><strong>{(held.reduce((sum, c) => sum + account.positions[c.coin_id] * (c.price / 1e15), 0)).toLocaleString('en-US', { maximumFractionDigits: 6 })} SOL</strong></div>
      <div className="card paper-balance"><small>Open positions</small><strong>{held.length}</strong></div></section>
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
  return <LaunchForm receipts={data.account.receipts} tickers={data.coins.map(c => c.ticker)} disabled={busy || offline || !!data.account.pending_launch}
    detail={'Launch fee ' + sol(data.launch_fee) + ' paper SOL. Accepted launches join the Line when the batch clears.'}
    submit={async (name, ticker) => {
      const result = await post('launches', { name, ticker, batch_id: data.batch_id })
      return result.batch_id
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
