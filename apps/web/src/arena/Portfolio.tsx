import { Link } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'
import { healthColor } from '../lib/health'
import { useMoney } from '../lib/money'
import type { ChainState } from '../wallet/ChainMarket'

type Account = NonNullable<ChainState['account']>

/** Isha's portfolio mockup on live ledger data. The ledger balance is the only balance shown. */
export function Portfolio({ account, state }: { account: Account; state: ChainState }) {
  const { money, signed } = useMoney()
  const held = state.markets
    .map((m) => ({ m, tokens: Number(account.positions?.[m.address] ?? 0) }))
    .filter((x) => x.tokens > 0)
  const value = (x: (typeof held)[number]) => (x.tokens * Number(x.m.price)) / 1e6
  const open = held.filter((x) => x.m.live).sort((a, b) => (a.m.survival ?? 1e9) - (b.m.survival ?? 1e9))
  const past = held.filter((x) => !x.m.live)
  const inCoins = open.reduce((n, x) => n + value(x), 0)
  const risk = open.find((x) => x.m.stage !== 'Line' && x.m.survival !== null && x.m.survival < 25)
  const cash = Number(account.cash ?? 0)
  // Account profit: realized on every sale, plus open positions against their average entry.
  // A coin that was cut is worth nothing, so its whole cost counts as a loss.
  const byAddress = new Map(state.markets.map((m) => [m.address, m]))
  let pnl = 0
  for (const [address, b] of Object.entries(account.basis ?? {})) {
    const m = byAddress.get(address)
    const worth = m?.live ? (Number(b.tokens) * Number(m.price)) / 1e6 : 0
    pnl += Number(b.realized) + (Number(b.tokens) > 0 ? worth - Number(b.cost) : 0)
  }
  const px = (micro?: string | null) => (micro ? Number((Number(micro) / 1e6).toPrecision(4)).toString() : '—')
  return (
    <div className="pf">
      <section className="pf-tiles">
        <div className="pf-tile main">
          <small>Balance</small>
          <strong>
            {money(cash, 4)}
          </strong>
          <span>{account.username ? '@' + account.username : 'Trading balance'}</span>
        </div>
        <div className="pf-tile">
          <small>In coins</small>
          <strong>
            {money(inCoins, 4)}
          </strong>
          <span>{open.length} coins held</span>
        </div>
        <div className="pf-tile">
          <small>Total</small>
          <strong>
            {money(cash + inCoins, 4)}
          </strong>
          <span>balance + coins at last clearing price</span>
        </div>
        <div className="pf-tile">
          <small>Profit / loss</small>
          <strong key={Math.round(pnl / 1e4)} className={pnl >= 0 ? 'green' : 'red'}>
            {signed(pnl, 4)}
          </strong>
          <span>
            realized + open positions
          </span>
        </div>
      </section>
      {risk && (
        <div className="pf-risk">
          <b>At risk</b>
          <span>
            {risk.m.name} has {Math.max(0, risk.m.survival ?? 0).toFixed(0)} survival left. If it is cut, your{' '}
            {money(value(risk), 4)} in it is voided and its reserve goes to the survivors.
          </span>
          <Link to={'/coin/' + risk.m.address}>Open coin</Link>
        </div>
      )}
      <section className="panel pf-table">
        <div className="panel-head">
          <h2>Positions</h2>
          <small>sorted by survival left</small>
        </div>
        <div className="pf-row head">
          <span>Coin</span>
          <span>Size</span>
          <span>Entry · price</span>
          <span>Value</span>
          <span>Profit / loss</span>
          <span>Health</span>
          <span />
        </div>
        {open.map((x) => {
          const surv = x.m.stage === 'Line' ? x.m.heat : Math.max(0, x.m.survival ?? 0)
          const b = account.basis?.[x.m.address]
          const cost = Number(b?.cost ?? 0)
          const gain = cost > 0 ? value(x) - cost : 0
          return (
            <div className={'pf-row' + (x === risk ? ' risky' : '')} key={x.m.address}>
              <span className="pf-coin">
                <CoinTile ticker={x.m.ticker} image={x.m.image} size={40} />
                <span>
                  <strong>
                    {x.m.name} {x.m.stage === 'Rookie' && <span className="tag tag-rookie">ROOKIE</span>}
                  </strong>
                  <small>
                    ${x.m.ticker} · {x.m.stage}
                  </small>
                </span>
              </span>
              <span className="mono">{x.tokens.toLocaleString()}</span>
              <span>
                {cost > 0 ? Number((cost / x.tokens).toPrecision(4)) : '—'}
                <small className="sub">now {Number((Number(x.m.price) / 1e6).toPrecision(4))}</small>
              </span>
              <span>{money(value(x), 4)}</span>
              <span className={gain >= 0 ? 'green' : 'red'}>
                {cost > 0 ? signed(gain, 4) : '—'}
                {cost > 0 && <small className="sub">{((value(x) / cost - 1) * 100).toFixed(1).replace('-', '−')}%</small>}
              </span>
              <span className="pf-timer">
                <b style={{ color: healthColor(x.m) }}>{x.m.stage === 'Line' ? surv.toFixed(1) + ' heat' : surv.toFixed(0)}</b>
                <i>
                  <i
                    style={{
                      width: Math.min(100, (surv / (x.m.stage === 'Line' ? 2 : 120)) * 100) + '%',
                      background: healthColor(x.m),
                    }}
                  />
                </i>
              </span>
              <Link className="pill-btn" to={'/coin/' + x.m.address}>
                Trade
              </Link>
            </div>
          )
        })}
        {!open.length && <p className="paper-empty">No open positions. Pick a coin on the board and buy into the next batch.</p>}
      </section>
      {past.length > 0 && (
        <section className="panel pf-table">
          <div className="panel-head">
            <h2>Past coins</h2>
            <small>coins you held when they were cut · their reserve went to survivors</small>
          </div>
          {past.map((x) => (
            <div className="pf-row past" key={x.m.address}>
              <span className="pf-coin">
                <CoinTile ticker={x.m.ticker} image={x.m.image} size={36} />
                <span>
                  <strong>
                    <s>{x.m.name}</s>
                  </strong>
                  <small>${x.m.ticker}</small>
                </span>
              </span>
              <span className="mono">{x.tokens.toLocaleString()}</span>
              <span />
              <span />
              <span className="mono red">voided</span>
              <span className="dim">{x.m.ended_reason ?? 'Cut'}</span>
              <span />
            </div>
          ))}
        </section>
      )}
      {!!account.orders?.length && (
        <section className="panel pf-table">
          <div className="panel-head">
            <h2>Recent orders</h2>
          </div>
          <div className="pf-order head">
            <span>Status</span>
            <span>Order</span>
            <span>Entry</span>
            <span>Exit</span>
            <span>Profit / loss</span>
          </div>
          {account.orders.slice(0, 12).map((o) => {
            const fill = o.status === 'filled' ? (JSON.parse(o.details) as { side: string; quantity: string }) : null
            const gain = o.pnl ? Number(o.pnl) : null
            return (
              <div className="pf-order" key={o.intent}>
                <span className={'tag ' + (o.status === 'filled' ? 'tag-new' : o.status === 'unfilled' ? 'tag-dead' : 'tag-rookie')}>{o.status}</span>
                <span>
                  {fill ? (
                    <>
                      {fill.side === 'buy' ? 'Bought' : 'Sold'} {Number(fill.quantity).toLocaleString()} ${o.ticker ?? ''}
                    </>
                  ) : (
                    <small>{o.details || '$' + (o.ticker ?? '') + ' · waiting for its batch'}</small>
                  )}
                </span>
                <span>{px(o.entry)}</span>
                <span>{fill?.side === 'sell' ? px(o.exit) : fill ? <small>open</small> : '—'}</span>
                <span className={gain === null ? 'dim' : gain >= 0 ? 'green' : 'red'}>
                  {gain === null ? '—' : signed(gain, 4)}
                </span>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}
