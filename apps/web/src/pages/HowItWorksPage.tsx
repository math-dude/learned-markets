import { Link } from 'react-router-dom'
import { StatusBadge } from '../components/CoinBits'
import { EPOCH_SECONDS, FEE, OWNERSHIP_CAP_SOL, STATUS_HELP } from '../market/seed'
import type { MakerStatus } from '../market/types'

const STEPS: [string, string][] = [
  ['The Board', 'Seated coins, ranked by market cap. The biggest one is king of the hill until another coin passes it.'],
  ['Survival timer', 'Every coin has a timer that counts down. Each trading round adds time based on how many different people traded, so lots of small traders keep a coin alive and a few big wallets don’t.'],
  ['Epochs', `When the epoch clock hits zero the coin with the least time left dies and is delisted. Holders of a dead coin are not paid out. (Epochs are ${EPOCH_SECONDS}s in this demo.)`],
  ['The Line', 'New coins wait in the Line. At each epoch the hottest one is seated on the Board as a rookie. Rookies graduate after surviving long enough.'],
  ['Rounds, not an order book', 'Orders are collected for a short round, then everyone in that round fills at one price. Matching buys and sells cancel out; only the leftover moves the price.'],
  ['The maker', 'A learned market maker absorbs part of each round’s leftover, so one big order moves the price less. Its status on each coin tells you how much it is helping.'],
  ['Picks', 'Each epoch you can guess which coin dies and which rookie gets seated. Picks are free and scored when the epoch closes.'],
]

export function HowItWorksPage() {
  return (
    <main style={{ flex: 1, padding: 20, display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 860 }}>
      <h1 style={{ margin: 0, fontSize: 26 }}>How it works</h1>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {STEPS.map(([title, body], i) => (
          <li key={title} className="card" style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>
            <span className="tnum" style={{ flex: 'none', width: 28, height: 28, borderRadius: 6, background: 'var(--accent-soft)', color: 'var(--violet-hi)', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {i + 1}
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="card-title">{title}</span>
              <span className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
                {body}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <section className="card">
        <span className="card-title">Maker status</span>
        {(Object.keys(STATUS_HELP) as MakerStatus[]).map((k) => (
          <span key={k} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <span style={{ width: 92, flex: 'none' }}>
              <StatusBadge status={k} />
            </span>
            <span className="muted" style={{ fontSize: 14, lineHeight: 1.45 }}>
              {STATUS_HELP[k]}
            </span>
          </span>
        ))}
      </section>
      <section className="card">
        <span className="card-title">Limits</span>
        <span className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          Trading fee is {FEE * 100}% per fill. A single buy can be at most {OWNERSHIP_CAP_SOL} SOL per person on a coin.
        </span>
      </section>
      <Link to="/" className="btn-primary" style={{ alignSelf: 'flex-start', padding: '11px 22px' }}>
        Go to the Board
      </Link>
    </main>
  )
}
