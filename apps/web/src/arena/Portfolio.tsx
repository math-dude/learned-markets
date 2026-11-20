import { Link } from 'react-router-dom'
import { CoinTile } from '../components/CoinBits'
import type { ChainState } from '../wallet/ChainMarket'

type Account = NonNullable<ChainState['account']>
const sol = (lamports: number) => (lamports / 1e9).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })

/** Isha's portfolio mockup on live ledger data. The ledger balance is the only balance shown. */
export function Portfolio({ account, state }: { account: Account; state: ChainState }) {
  const held = state.markets
    .map((m) => ({ m, tokens: Number(account.positions?.[m.address] ?? 0) }))
    .filter((x) => x.tokens > 0)
  const value = (x: (typeof held)[number]) => (x.tokens * Number(x.m.price)) / 1e6
  const open = held.filter((x) => x.m.live).sort((a, b) => (a.m.survival ?? 1e9) - (b.m.survival ?? 1e9))
  const past = held.filter((x) => !x.m.live)
  const inCoins = open.reduce((n, x) => n + value(x), 0)
  const risk = open.find((x) => x.m.stage !== 'Line' && x.m.survival !== null && x.m.survival < 25)
  const cash = Number(account.cash ?? 0)
  return (
    <div className="pf">
      <section className="pf-tiles">
        <div className="pf-tile main">
          <small>Balance</small>
          <strong>
            {sol(cash)} <em>SOL</em>
          </strong>
          <span className="mono dim">{account.wallet.slice(0, 4) + '…' + account.wallet.slice(-4)}</span>
        </div>
        <div className="pf-tile">
          <small>In coins</small>
          <strong>
            {sol(inCoins)} <em>SOL</em>
          </strong>
          <span>{open.length} coins held</span>
        </div>
        <div className="pf-tile">
          <small>Total</small>
          <strong className="green">
            {sol(cash + inCoins)} <em>SOL</em>
          </strong>
          <span>balance + coins at last clearing price</span>
        </div>
        <div className="pf-tile">
          <small>Orders</small>
          <strong className="violet">{account.orders?.length ?? 0}</strong>
          <span>{account.orders?.filter((o) => o.status === 'filled').length ?? 0} filled in batches</span>
        </div>
      </section>
      {risk && (
        <div className="pf-risk">
          <b>At risk</b>
          <span>
            {risk.m.name} has {Math.max(0, risk.m.survival ?? 0).toFixed(0)} survival left. If it is cut, your{' '}
            {sol(value(risk))} SOL in it is voided and its reserve goes to the survivors.
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
          <span>Price</span>
          <span>Value</span>
          <span>Survival</span>
          <span />
        </div>
        {open.map((x) => {
          const surv = x.m.stage === 'Line' ? x.m.heat : Math.max(0, x.m.survival ?? 0)
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
              <span className="mono">{Number((Number(x.m.price) / 1e6).toPrecision(4))}</span>
              <span className="mono">{sol(value(x))} SOL</span>
              <span className="pf-timer">
                <b className={x === risk ? 'red' : ''}>{x.m.stage === 'Line' ? surv.toFixed(1) + ' heat' : surv.toFixed(0)}</b>
                <i>
                  <i style={{ width: Math.min(100, (surv / (x.m.stage === 'Line' ? 2 : 120)) * 100) + '%' }} />
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
          {account.orders.slice(0, 12).map((o) => (
            <div className="pf-order" key={o.intent}>
              <span className={'tag ' + (o.status === 'filled' ? 'tag-new' : o.status === 'unfilled' ? 'tag-dead' : 'tag-rookie')}>{o.status}</span>
              <span className="dim">
                {o.details && o.status === 'filled' ? JSON.parse(o.details).quantity + ' tokens filled' : o.details}
              </span>
              <code>{o.signature ? o.signature.slice(0, 10) + '…' : ''}</code>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
