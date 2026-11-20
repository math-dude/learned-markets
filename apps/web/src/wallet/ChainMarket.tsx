import { useEffect, useState } from 'react'
import '../arena/arena.css'
import { ProofPage } from '../arena/ProofPage'
import { Portfolio } from '../arena/Portfolio'
import { Link, useLocation } from 'react-router-dom'
import { Search, ShellFrame } from '../components/Shell'
import { AccessPanel } from './AccessPanel'
import { gateRequest, useWallet } from './access'
import { ChainLaunch, ChainOrder } from './ChainActions'
import { MarketHeading, MarketHistory, SurvivalPanel, ValidatorBoard } from './ValidatorBoard'

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
    participant: string
    signature: string
    quantity: string
    price: string | null
  }[]
  candles: { batch: number; o: string; h: string; l: string; c: string; v: string }[]
  batch_slots: number
  markets: {
    address: string
    name: string
    ticker: string
    kind: string
    price: string
    stage: string
    live: boolean
    survival: number | null
    heat: number
    activity: number
    reserve_cash: string
    reserve_tokens: string
    image?: string | null
    ended_reason?: string | null
  }[]
  rounds?: {
    market: string
    batch: number
    buys: string
    sells: string
    matched: string
    maker_side: 'buy' | 'sell' | null
    maker_qty: string
    price: string | null
  }[]
  flows?: {
    batch: number
    market: string
    ticker: string
    total: string
    survivors: { address: string; ticker: string; amount: string }[]
    deployers_amount: string
    platform_amount: string
    signature: string | null
    ts?: number
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
        const response = await fetch(
          '/api/chain?' +
            new URLSearchParams({
              ...(address ? { wallet: address } : {}),
              ...(pathname.startsWith('/coin/') ? { market: pathname.slice(6) } : {}),
            }),
          {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
            cache: 'no-store',
          },
        )
        if (!response.ok) throw new Error()
        const snapshot: ChainState = await response.json()
        if (!controller.signal.aborted) {
          setState(snapshot)
          setError('')
        }
      } catch {
        if (!controller.signal.aborted) setError('The backend could not read the validator. Reconnecting…')
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, 2000)
      }
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [address, revision, pathname])
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
              image: m.image ?? undefined,
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
      {activeMarket ? (
        <div className="artifact-coin-layout">
          <main className="artifact-coin-main">
            <MarketHeading market={activeMarket} fills={state?.fills ?? []} />
            {error && (
              <p role="alert" className="paper-warning">
                {error}
              </p>
            )}
            <MarketHistory market={activeMarket} fills={state?.fills ?? []} candles={state?.candles ?? []} rounds={state?.rounds} />
          </main>
          <aside className="artifact-coin-sidebar">
            {activeMarket.live && admitted && wallet ? (
              <ChainOrder
                key={activeMarket.address}
                wallet={wallet}
                market={activeMarket.address}
                refresh={update}
                ticker={activeMarket.ticker}
                marketPrice={activeMarket.price}
                holding={account?.positions?.[activeMarket.address] ?? '0'}
              />
            ) : (
              <Link className="btn-primary" to="/portfolio">
                {activeMarket.live ? 'Verify wallet to trade' : 'Market ended'}
              </Link>
            )}
            <section className="card">
              <h2>Your position</h2>
              <div className="position-metrics">
                <div>
                  <small>Holding</small>
                  <strong>
                    {BigInt(account?.positions?.[activeMarket.address] ?? '0').toLocaleString()}{' '}
                    {activeMarket.ticker}
                  </strong>
                </div>
                <div>
                  <small>Value</small>
                  <strong>
                    {(
                      (Number(account?.positions?.[activeMarket.address] ?? 0) * Number(activeMarket.price)) /
                      1e15
                    ).toFixed(5)}{' '}
                    SOL
                  </strong>
                </div>
              </div>
            </section>
            <SurvivalPanel market={activeMarket} />
            <section className="card maker-card">
              <span className="badge badge-outline">Batch clearing</span>
              <p>
                The maker trades the remaining imbalance. Every fill in a round shares the same clearing
                price.
              </p>
            </section>
          </aside>
        </div>
      ) : pathname === '/proof' || pathname === '/how-it-works' ? (
        <ProofPage />
      ) : pathname === '/' && state ? (
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
          {activeMarket ? (
            <MarketHeading market={activeMarket} fills={state?.fills ?? []} />
          ) : (
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
                        : 'Board'}
                </h1>
              </div>
              {pathname === '/' && (
                <Link className="chip chip-strong" to="/launch">
                  Launch a coin ↗
                </Link>
              )}
            </header>
          )}
          {error && <p role="alert">{error}</p>}
          {portfolio ? (
            <section className="account-entry-wrap">
              {account?.participant && state && <Portfolio account={account} state={state} />}
              {!admitted &&
                (!address || state?.gate_ready
                  ? verify
                  : state && (
                      <p>
                        Participant registration opens when the operator initializes the gate on this
                        validator.
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
          ) : (
            <section className="card">
              <h2>{pathname === '/launch' ? 'Verify your wallet to launch a coin' : 'Connecting…'}</h2>
              <Link to="/portfolio">View wallet</Link>
            </section>
          )}
        </main>
      )}
    </ShellFrame>
  )
}
