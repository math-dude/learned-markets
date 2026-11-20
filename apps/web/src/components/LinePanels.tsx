import { useState } from 'react'
import { ago, timeLeft } from '../lib/format'
import { useNow } from '../lib/useNow'
import { market, useMarket } from '../market/engine'
import { CoinTile } from './CoinBits'

/** Free predictions scored when the epoch closes. */
export function PicksPanel() {
  const s = useMarket()
  const dieOpts = s.coins.filter((c) => !c.gone).sort((a, b) => a.secs - b.secs).slice(0, 3)
  const seatOpts = [...s.line].sort((a, b) => b.heat - a.heat).slice(0, 3)
  return (
    <section aria-label="Your picks" className="card" style={{ gap: 10, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span className="card-title">Your picks this epoch</span>
        <span className="muted tnum" style={{ fontSize: 13 }}>
          <span style={{ color: 'var(--violet-hi)', fontWeight: 700 }}>{s.pickRight}</span> of {s.pickTotal} right
        </span>
      </div>
      <PickGroup label="Which coin dies?">
        {dieOpts.map((c) => (
          <button key={c.id} type="button" className="pill-btn xs" aria-pressed={s.pickDie === c.id} onClick={() => market.pickDie(c.id)}>
            {c.name}{' '}
            <span className="tnum red">{timeLeft(c.secs)}</span>
          </button>
        ))}
      </PickGroup>
      <PickGroup label="Which rookie gets seated?">
        {seatOpts.map((l) => (
          <button key={l.id} type="button" className="pill-btn xs" aria-pressed={s.pickSeat === l.id} onClick={() => market.pickSeat(l.id)}>
            {l.name}
          </button>
        ))}
      </PickGroup>
      <span style={{ fontSize: 12, color: 'var(--dim)' }}>free · scored when the epoch closes</span>
    </section>
  )
}

function PickGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="muted" style={{ fontSize: 13 }}>
        {label}
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{children}</div>
    </div>
  )
}

const SEAT_HEAT = 70

/** Coins waiting for a seat. The hottest one is seated at the next epoch. */
export function LineList() {
  const s = useMarket()
  const [sort, setSort] = useState<'hot' | 'new'>('hot')
  const byHeat = [...s.line].sort((a, b) => b.heat - a.heat)
  const nextId = byHeat[0]?.id
  const rows = sort === 'hot' ? byHeat : [...s.line].sort((a, b) => b.bornAt - a.bornAt)
  const now = useNow(5000)
  return (
    <>
      <div style={{ padding: '14px 20px 12px' }} className="section-title">
        The Line
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '0 20px 14px' }}>
        <button type="button" className="pill-btn" aria-pressed={sort === 'hot'} onClick={() => setSort('hot')}>
          Hottest
        </button>
        <button type="button" className="pill-btn" aria-pressed={sort === 'new'} onClick={() => setSort('new')}>
          Newest
        </button>
      </div>
      {rows.map((l) => {
        const next = l.id === nextId
        const pct = Math.min(100, Math.round((l.heat / SEAT_HEAT) * 100)) + '%'
        return (
          <article key={l.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <CoinTile tint={l.tint} ticker={l.ticker} size={48} />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontWeight: 600 }}>
                  {l.name}
                  {l.mine && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--violet-hi)' }}>yours</span>}
                </span>
                <span className="muted" style={{ fontSize: 13 }}>
                  {l.ticker} · {ago(now - l.bornAt)} · {l.people} people
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, fontSize: 13 }}>
                <span className="tnum">
                  <span className="muted">heat</span> {l.heat}
                </span>
                <span style={{ color: next ? 'var(--violet)' : 'var(--muted)' }}>{next ? 'seats next epoch' : 'waiting'}</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, height: 4, borderRadius: 6, background: 'var(--nav-active)' }}>
                <div className={next ? 'lm-seat' : ''} style={{ height: 4, width: pct, borderRadius: 6, background: next ? 'var(--accent-2)' : '#4A4A52', transition: 'width 0.6s ease' }} />
              </div>
              <span className="tnum" style={{ fontSize: 11, color: '#8A8A93' }}>
                {pct} to a seat
              </span>
            </div>
          </article>
        )
      })}
    </>
  )
}
