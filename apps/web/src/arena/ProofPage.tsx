import { useState } from 'react'
import data from './demo-data.json'
import { LineChart, type Series } from './LineChart'

// Validated pair (dark surface #0d0b18): lightness band, CVD ΔE 12.5, normal ΔE 29.8.
const PUMP = '#e84a76'
const OURS = '#1a9fbf'
const TRUTH = '#8b8a99'

const pair = (pump: number[], ours: number[], truth?: number[]): Series[] => [
  ...(truth ? [{ name: 'True value', color: TRUTH, values: truth, dashed: true }] : []),
  { name: 'pump.fun', color: PUMP, values: pump },
  { name: 'Learned', color: OURS, values: ours, area: true },
]

function Stat({ value, label, pump, ours }: { value: string; label: string; pump: string; ours: string }) {
  return (
    <div className="proof-stat">
      <strong>{value}</strong>
      <span>{label}</span>
      <small>
        <i style={{ background: PUMP }} /> pump {pump} <i style={{ background: OURS }} /> ours {ours}
      </small>
    </div>
  )
}

export function ProofPage() {
  const { whale, pnd, memes, money } = data
  const [meme, setMeme] = useState(0)
  const m = memes[meme]
  const last = <T,>(a: T[]) => a[a.length - 1]
  return (
    <main className="proof-page">
      <header className="proof-hero">
        <span className="eyebrow">Replay · same crowd, same seeds, two markets</span>
        <h1>
          Why batch auctions with a learned maker beat the bonding curve
        </h1>
        <p>{data.note} The left market is pump.fun’s curve with orders executed first-come. The right is ours: sealed batch auctions, one clearing price per batch, a maker trained with RL.</p>
        <div className="proof-legend">
          <span>
            <i style={{ background: PUMP }} /> pump.fun bonding curve
          </span>
          <span>
            <i style={{ background: OURS }} /> Learned Markets
          </span>
          <span>
            <i className="dash" /> Hidden true value
          </span>
        </div>
      </header>

      <section className="proof-stats">
        <Stat
          value={(last(whale.pump) / last(whale.ours)).toFixed(0) + '×'}
          label="less supply a whale can corner"
          pump={last(whale.pump).toFixed(1) + '%'}
          ours={last(whale.ours).toFixed(1) + '%'}
        />
        <Stat
          value={(pnd.peak_pump_median / pnd.peak_ours_median).toFixed(1) + '×'}
          label="smaller pump-and-dump spike"
          pump={pnd.peak_pump_median + '× launch'}
          ours={pnd.peak_ours_median + '× launch'}
        />
        <Stat
          value={(last(money.pump.dead) / last(money.ours.dead)).toFixed(1) + '×'}
          label="less money trapped in dead coins"
          pump={last(money.pump.dead).toFixed(0) + ' SOL'}
          ours={last(money.ours.dead).toFixed(0) + ' SOL'}
        />
        <Stat
          value={(last(money.pump.top10) / last(money.ours.top10)).toFixed(1) + '×'}
          label="less supply in the top 10 wallets"
          pump={last(money.pump.top10).toFixed(1) + '%'}
          ours={last(money.ours.top10).toFixed(1) + '%'}
        />
      </section>

      <section className="proof-scene">
        <div className="scene-copy">
          <span className="scene-n">01</span>
          <h2>A whale tries to corner a coin</h2>
          <p>
            On the curve, a hoarder keeps buying and ends up holding a third of the supply. In a batch, everyone clears at
            the same price, and the learned maker caps how much one wallet can take each round.
          </p>
        </div>
        <div className="chart-card">
          <h3>Supply held by the biggest wallet</h3>
          <LineChart x={whale.minutes} series={pair(whale.pump, whale.ours)} unit="%" yMin={0} format={(v) => v.toFixed(0)} />
        </div>
      </section>

      <section className="proof-scene">
        <div className="scene-copy">
          <span className="scene-n">02</span>
          <h2>A cabal pumps and dumps</h2>
          <p>
            Two wallets buy hard for {pnd.buy_until_min.toFixed(1)} minutes, wait, then dump. On pump the price spikes to{' '}
            {Math.max(...pnd.pump).toFixed(1)}× while interest stays flat. On ours the maker reads the one-sided flow and
            barely moves, so the cabal has nothing to dump into.
          </p>
        </div>
        <div className="chart-pair">
          <div className="chart-card">
            <h3>Price, multiple of launch</h3>
            <LineChart
              x={pnd.minutes}
              series={pair(pnd.pump, pnd.ours, pnd.interest)}
              unit="×"
              yMin={0}
              bands={[
                { from: 0, to: pnd.buy_until_min, label: 'cabal buys', tone: 'buy' },
                { from: pnd.dump_from_min, to: pnd.dump_from_min + 2, label: 'dump', tone: 'sell' },
              ]}
            />
          </div>
          <div className="chart-card">
            <h3>Cabal profit, SOL (median across worlds)</h3>
            <LineChart x={pnd.minutes} series={pair(pnd.attacker_pump, pnd.attacker_ours)} format={(v) => v.toFixed(1)} />
          </div>
        </div>
      </section>

      <section className="proof-scene">
        <div className="scene-copy">
          <span className="scene-n">03</span>
          <h2>Price follows what the meme is actually worth</h2>
          <p>
            Each coin has hidden interest: the dashed line. The closer the price tracks it, the less early buyers get
            farmed by latecomers. Pick a meme type:
          </p>
          <div className="seg wrap">
            {memes.map((x, i) => (
              <button key={x.key} aria-pressed={i === meme} onClick={() => setMeme(i)}>
                {x.title.replace(/^Meme /, '').replace(/^that |^with |^hit by /, '')}
              </button>
            ))}
          </div>
          <div className="scene-kpis">
            <div>
              <strong>{Math.round(m.ours_closer_share * 100)}%</strong>
              <small>of {m.memes} memes where ours tracked closer</small>
            </div>
            <div>
              <strong>
                {Math.round(m.pump_off * 100)}% → {Math.round(m.ours_off * 100)}%
              </strong>
              <small>average mispricing, pump → ours</small>
            </div>
          </div>
        </div>
        <div className="chart-card">
          <h3>{m.title}</h3>
          <LineChart key={m.key} x={m.minutes} series={pair(m.pump, m.ours, m.interest)} unit="×" yMin={0} height={280} />
        </div>
      </section>

      <section className="proof-scene stacked">
        <div className="scene-copy">
          <span className="scene-n">04</span>
          <h2>Where the money ends up</h2>
          <p>
            A full market over {Math.round(last(money.ours.minutes))} minutes with launches, cuts and a mix of attackers. Less
            money dies with dead coins (and on chain, what remains in a dead coin’s reserve is recycled to survivors,
            builders and the house), and holders end up less concentrated.
          </p>
        </div>
        <div className="proof-grid">
          {(
            [
              ['Retail P&L per person', 'retail', ' SOL', (v: number) => v.toFixed(2)],
              ['Money trapped in dead coins', 'dead', '', (v: number) => v.toFixed(0)],
              ['Top-10 wallets’ share of supply', 'top10', '%', (v: number) => v.toFixed(0)],
              ['Fees collected', 'fees', '', (v: number) => v.toFixed(0)],
            ] as const
          ).map(([title, key, unit, fmt]) => (
            <div className="chart-card" key={key}>
              <h3>
                {title}
                {unit === '' ? ' · SOL' : ''}
              </h3>
              <LineChart
                compact
                height={190}
                x={money.ours.minutes}
                series={pair(money.pump[key], money.ours[key])}
                unit={unit === '%' ? '%' : ''}
                format={fmt}
              />
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
