import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Search, ShellFrame } from '../components/Shell'
import { AccessPanel } from './AccessPanel'
import { gateRequest, useWallet } from './access'
import { ChainLaunch, ChainOrder } from './ChainActions'
import { MarketHistory, ValidatorBoard } from './ValidatorBoard'

export type ChainState = {
  network: string
  program: string
  slot: number
  gate_ready: boolean
  fills: {
    intent: string
    market: string
    batch: number
    side: string
    quantity: string
    price: string | null
  }[]
  batch_slots: number
  markets: {
    address: string
    name: string
    ticker: string
    kind: string
    price: string
    stage: string
    reserve_cash: string
    reserve_tokens: string
  }[]
  account: {
    wallet: string
    lamports: string
    participant: string | null
    cash?: string | null
    positions?: Record<string, string>
    orders?: { intent: string; status: string; signature: string | null; details: string }[]
  } | null
}

export function ChainMarket() {
  const wallet = useWallet()
  const { pathname } = useLocation()
  const [state, setState] = useState<ChainState>()
  const [error, setError] = useState('')
  const [revision, refresh] = useState(0)
  const address = wallet?.address
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const response = await fetch('/api/chain' + (address ? '?wallet=' + encodeURIComponent(address) : ''), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
          cache: 'no-store',
        })
        if (!response.ok) throw new Error()
        const snapshot: ChainState = await response.json()
        if (!controller.signal.aborted) {
          setState(snapshot)
          setError('')
        }
      } catch {
        if (!controller.signal.aborted) setError('The backend could not read the validator. Reconnecting…')
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, 4500)
      }
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [address, revision])
  const account = state?.account?.wallet === address ? state?.account : null
  const [sessionWallet, setSessionWallet] = useState('')
  useEffect(() => {
    let active = true
    if (address)
      gateRequest<{ wallet: string; eligible: boolean }>('me')
        .then((me) => {
          if (active) setSessionWallet(me.eligible ? me.wallet : '')
        })
        .catch(() => {
          if (active) setSessionWallet('')
        })
    return () => {
      active = false
    }
  }, [address, revision])
  const admitted = !!address && sessionWallet === address
  const verify = (
    <AccessPanel
      connect={async () => {
        refresh((v) => v + 1)
      }}
    />
  )
  const activeMarket = state?.markets.find((m) => pathname === '/coin/' + m.address)
  const update = () => refresh((v) => v + 1)
  const portfolio = pathname === '/portfolio'
  return (
    <ShellFrame
      bar={
        <header className="topbar">
          <Search
            coins={(state?.markets ?? []).map((m) => ({
              key: m.address,
              name: m.name,
              ticker: m.ticker,
              tint: 'var(--accent-soft)',
              where: m.stage,
              to: '/coin/' + m.address,
            }))}
          />
          <span className="paper-label">
            {state?.network === 'surfpool' ? 'Surfpool' : (state?.network ?? 'Connecting')} ·{' '}
            {state ? 'Slot ' + state.slot.toLocaleString() : 'Validator'}
          </span>
          <Link to="/portfolio" className="chip chip-strong">
            Wallet
          </Link>
        </header>
      }
    >
      {pathname === '/' && state ? (
        <>
          {error && (
            <p className="paper-warning" role="alert">
              {error}
            </p>
          )}
          <ValidatorBoard state={state} />
        </>
      ) : (
        <main className="paper-page portfolio-entry">
          <header className="validator-mast">
            <div>
              <span className="eyebrow">Learned Markets</span>
              <h1>
                {portfolio
                  ? 'Your wallet'
                  : pathname === '/launch'
                    ? 'Launch a coin'
                    : pathname === '/how-it-works'
                      ? 'How it works'
                      : (activeMarket?.name ?? 'Board')}
              </h1>
            </div>
            {pathname === '/' && (
              <Link className="chip chip-strong" to="/launch">
                Launch a coin ↗
              </Link>
            )}
          </header>
          {error && <p role="alert">{error}</p>}
          {portfolio ? (
            <section className="card account-entry">
              <h2>Solana balance</h2>
              {account && (
                <>
                  <strong className="wallet-balance">
                    {(BigInt(account.lamports) / 1_000_000_000n).toString()}.
                    {(BigInt(account.lamports) % 1_000_000_000n)
                      .toString()
                      .padStart(9, '0')
                      .replace(/0+$/, '') || '0'}{' '}
                    SOL
                  </strong>
                  <code>{account.wallet}</code>
                </>
              )}
              {account?.participant && (
                <>
                  <small>Registered participant</small>
                  <code>{account.participant}</code>
                </>
              )}
              {account?.participant && (
                <>
                  <h2>Trading balance</h2>
                  <strong>
                    {account.cash
                      ? (Number(account.cash) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 })
                      : '0'}{' '}
                    ledger SOL
                  </strong>
                  {state?.markets
                    .filter((m) => account.positions?.[m.address])
                    .map((m) => (
                      <Link key={m.address} to={'/coin/' + m.address}>
                        {m.name} · {account.positions?.[m.address]} tokens
                      </Link>
                    ))}
                  {account.orders?.map((o) => (
                    <div className="card" key={o.intent}>
                      <strong>Order · {o.status}</strong>
                      <small>
                        {o.details &&
                          (o.status === 'filled'
                            ? JSON.parse(o.details).quantity + ' tokens filled'
                            : o.details)}
                      </small>
                      <code>{o.signature}</code>
                    </div>
                  ))}
                </>
              )}
              {!admitted &&
                (!address || state?.gate_ready
                  ? verify
                  : state && (
                      <p>
                        Participant registration opens when the operator initializes the gate on this validator.
                      </p>
                    ))}
            </section>
          ) : pathname === '/how-it-works' ? (
            <section className="card">
              <h2>Wallet and settlement</h2>
              <p>
                Privy signs with your Solana wallet. The backend reads confirmed market accounts from the
                validator.
              </p>
            </section>
          ) : pathname === '/launch' && admitted && wallet ? (
            <ChainLaunch wallet={wallet} refresh={update} />
          ) : activeMarket ? (
            <div className="paper-grid">
              <MarketHistory market={activeMarket} fills={state?.fills ?? []} />
              <section className="card account-entry">
                <small>{activeMarket.stage} · Last clearing price</small>
                <h2>
                  {activeMarket.price === '0' ? 'Awaiting first fill' : activeMarket.price + ' micro-lamports'}
                </h2>
                {activeMarket.kind === 'ledger' &&
                  activeMarket.stage === 'Open' &&
                  (admitted && wallet ? (
                    <ChainOrder
                      key={activeMarket.address}
                      wallet={wallet}
                      market={activeMarket.address}
                      refresh={update}
                    />
                  ) : (
                    <Link to="/portfolio">Verify wallet to trade</Link>
                  ))}
              </section>
            </div>
          ) : (
            <section className="card">
              <h2>
                {pathname === '/launch'
                  ? 'Verify your wallet to launch a market'
                  : state
                    ? 'Market unavailable'
                    : 'Loading markets…'}
              </h2>
              <Link to={pathname === '/launch' ? '/portfolio' : '/'}>
                {pathname === '/launch' ? 'View participant wallet' : 'View board'}
              </Link>
            </section>
          )}
        </main>
      )}
    </ShellFrame>
  )
}
