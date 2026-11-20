import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CoinTile, RookieBadge } from '../components/CoinBits'
import { Crown, PersonIcon, TimerIcon } from '../components/icons'
import { LineList, PicksPanel } from '../components/LinePanels'
import { clock, money, signedPct, timeLeft } from '../lib/format'
import { useMarket } from '../market/engine'
import { EPOCH_SECONDS, GRAD_SECONDS, STATUS_COLORS, priceOf } from '../market/seed'
import type { Coin } from '../market/types'
import './board.css'

const ROW_H = 104
type SortKey = 'mc' | 'ov' | 'change' | 'rookies'
const SORTS: [SortKey, string][] = [
  ['mc', 'Market cap'],
  ['ov', 'Organic volume'],
  ['change', 'Price change'],
  ['rookies', 'Rookies'],
]

const changeOf = (c: Coin) => (c.mcNum / c.openMc - 1) * 100

export function BoardPage() {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <EpochToast />
      <EpochHero />
      <Headlines />
      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap' }}>
        <BoardList />
        <section aria-label="The Line" style={{ flex: '1 1 340px', minWidth: 0 }}>
          <div style={{ margin: '14px 20px 4px' }}>
            <PicksPanel />
          </div>
          <LineList />
        </section>
      </div>
    </div>
  )
}

function EpochToast() {
  const s = useMarket()
  if (!s.showEpoch) return null
  return (
    <div role="status" className="epoch-toast">
      <span style={{ fontWeight: 700 }}>Epoch closed</span>
      <span className="muted" style={{ fontSize: 14 }}>
        {s.epochSummary}
      </span>
      {s.pickResult && <span style={{ fontSize: 14, color: 'var(--text-2)' }}>{s.pickResult}</span>}
    </div>
  )
}

function EpochHero() {
  const s = useMarket()
  const e = s.epoch
  const urgent = e <= 10
  const color = urgent ? 'var(--gold)' : 'var(--text)'
  const kothClass = s.phase ? { challenge: 'lm-shake', out: 'lm-out', in: 'lm-in lm-take' }[s.phase] : ''
  const king = s.king
  const alive = s.coins.filter((c) => !c.gone)
  const lit = Math.ceil((e / EPOCH_SECONDS) * 25)
  return (
    <>
      <section
        aria-label="Next epoch"
        className="epoch-hero"
        style={{ background: `radial-gradient(ellipse at center, ${urgent ? 'rgba(251,191,36,0.16)' : 'rgba(124,58,237,0.16)'} 0%, rgba(0,0,0,0) 60%)` }}
      >
        {s.phase === 'in' && <div className="lm-sweep" aria-hidden="true" />}
        <Link to={`/coin/${king.ticker}`} className={kothClass} style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0, borderRadius: 6, color: 'var(--text)' }}>
          <div className="tile" style={{ width: 88, height: 88, background: '#2D2A24', border: '1px solid #8A6A1E', fontWeight: 800, fontSize: 20 }}>
            {king.ticker}
            <span key={String(s.crownFlip)} className={s.crownFlip ? 'lm-crown-b' : 'lm-crown'} aria-hidden="true" style={{ position: 'absolute', top: -20, left: -14 }}>
              <Crown />
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
            <span style={{ fontSize: 13, color: 'var(--gold)', fontWeight: 700 }}>#1 · king of the hill</span>
            <span className="ellipsis" style={{ fontWeight: 700, fontSize: 22 }}>
              {king.name} <span className="muted" style={{ fontWeight: 400, fontSize: 16 }}>{king.ticker}</span>
            </span>
            <span className="muted tnum" style={{ fontSize: 14 }}>
              OV <span style={{ color: 'var(--text)' }}>{money(king.ovNum)}</span> · MC <span style={{ color: 'var(--text)' }}>{money(king.mcNum)}</span> ·{' '}
              <span style={{ color: changeOf(king) >= 0 ? 'var(--green)' : 'var(--red)' }}>{signedPct(changeOf(king), 0)}</span>
            </span>
          </div>
        </Link>
        <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <span className="eyebrow">Next epoch</span>
          <span className={'epoch-clock' + (urgent ? ' lm-beat' : '')} style={{ color }}>
            {clock(e)}
          </span>
          <div aria-hidden="true" style={{ display: 'flex', gap: 3 }}>
            {Array.from({ length: 25 }, (_, i) => {
              const t = i / 24
              const mix = (a: number, b: number) => Math.round(a + (b - a) * t)
              const on = `rgb(${mix(91, 192)},${mix(33, 132)},${mix(182, 252)})`
              return <span key={i} style={{ width: 7, height: 16, borderRadius: 2, background: i < lit ? (urgent ? 'var(--gold)' : on) : 'var(--nav-active)', transition: 'background 0.4s ease' }} />
            })}
          </div>
          <span className="muted" style={{ fontSize: 14 }}>
            dead coins removed · Line coins seated
          </span>
        </div>
        <div className="tnum" style={{ display: 'flex', justifyContent: 'flex-end', gap: 28 }}>
          <HeroStat value={alive.length + 1} label="seated" />
          <HeroStat value={alive.filter((c) => c.grad !== null).length} label="rookies" color="var(--gold)" />
          <HeroStat value={s.line.length} label="in the Line" />
        </div>
      </section>
      <div aria-hidden="true" style={{ height: 3, background: 'var(--surface)' }}>
        <div style={{ height: 3, width: `${Math.round(((EPOCH_SECONDS - e) / EPOCH_SECONDS) * 100)}%`, background: color, transition: 'width 1s linear' }} />
      </div>
    </>
  )
}

function HeroStat({ value, label, color }: { value: number; label: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <span style={{ fontSize: 30, fontWeight: 800, color }}>{value}</span>
      <span className="muted" style={{ fontSize: 13 }}>
        {label}
      </span>
    </div>
  )
}

function Headlines() {
  const s = useMarket()
  const items = [...s.headlines, ...s.headlines]
  return (
    <div role="marquee" aria-label={`Latest: ${s.headlines[0]}`} className="headlines">
      <div className={'headlines-label' + (s.newKing ? ' lm-live' : '')}>
        <Crown width={18} height={13} stroke="#2E1065" />
        {s.newKing ? 'New king' : 'Live'}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', overflow: 'hidden', fontWeight: 600, fontSize: 14 }}>
        <div className="lm-ticker" style={{ display: 'flex', width: 'max-content' }}>
          {items.map((h, i) => (
            <span key={i} aria-hidden={i >= s.headlines.length} style={{ display: 'inline-flex', alignItems: 'center', gap: 12, padding: '0 28px', whiteSpace: 'nowrap' }}>
              <span aria-hidden="true" className="gold">
                ◆
              </span>
              {h}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function BoardList() {
  const s = useMarket()
  const navigate = useNavigate()
  const [sort, setSort] = useState<SortKey>('mc')

  // Rank is always by market cap (the king is #1).
  const mcRank: Record<number, number> = {}
  s.coins
    .slice()
    .sort((x, y) => Number(x.gone) - Number(y.gone) || y.mcNum - x.mcNum)
    .forEach((c, i) => {
      mcRank[c.id] = i
    })

  const key = (c: Coin) => (sort === 'ov' ? c.ovNum : sort === 'change' ? changeOf(c) : c.mcNum)
  const visible = s.coins.filter((c) => sort !== 'rookies' || c.grad !== null)
  const order: Record<number, number> = {}
  visible
    .slice()
    .sort((x, y) => Number(x.gone) - Number(y.gone) || key(y) - key(x))
    .forEach((c, i) => {
      order[c.id] = i
    })

  return (
    <section aria-label="Board" style={{ flex: '999 1 640px', minWidth: 0, borderRight: '1px solid var(--border)' }}>
      <div style={{ padding: '14px 20px 12px' }} className="section-title">
        Board
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '0 20px 14px' }}>
        {SORTS.map(([k, label]) => (
          <button key={k} type="button" className="pill-btn" aria-pressed={sort === k} onClick={() => setSort(k)}>
            {label}
          </button>
        ))}
      </div>
      {visible.length === 0 && (
        <p className="muted" style={{ padding: '12px 20px' }}>
          No rookies on the board right now.
        </p>
      )}
      <div style={{ position: 'relative', height: visible.length * ROW_H }}>
        {s.coins
          .filter((c) => order[c.id] !== undefined)
          .slice()
          .sort((a, b) => a.id - b.id)
          .map((c) => (
            <BoardRow key={c.id} c={c} y={order[c.id] * ROW_H} rank={mcRank[c.id] + 2} challenger={c.id === s.challengerId} out={c.id === s.challengerId && s.phase === 'out'} onOpen={() => navigate(`/coin/${c.ticker}`)} />
          ))}
      </div>
    </section>
  )
}

function BoardRow({ c, y, rank, challenger, out, onOpen }: { c: Coin; y: number; rank: number; challenger: boolean; out: boolean; onOpen: () => void }) {
  const change = changeOf(c)
  const rising = c.grad !== null && !c.graduating
  const statusColor = STATUS_COLORS[c.status]
  const cls = [c.isNew ? 'lm-new' : '', challenger ? 'lm-challenge' : '', c.dethroned ? 'lm-dethroned' : '', 'board-row'].join(' ')
  return (
    <article
      className={cls}
      onClick={c.gone ? undefined : onOpen}
      style={{
        transform: `translateY(${out ? -90 : y}px) scale(${challenger ? 1.035 : c.moveDir === 'up' ? 1.02 : c.moveDir === 'down' ? 0.985 : 1})`,
        background: c.graduating ? '#2A2410' : c.flash === 'up' ? '#0F2420' : c.flash === 'down' ? '#2A1520' : 'var(--bg)',
        opacity: out ? 0 : c.gone ? 0.25 : c.moveDir === 'down' ? 0.7 : 1,
        zIndex: challenger ? 4 : c.moveDir === 'up' ? 3 : c.moveDir === 'down' ? 1 : 2,
        boxShadow: c.moveDir === 'up' ? '0 14px 34px rgba(0,0,0,0.6), 0 0 0 1px #6D28D9, 0 0 24px rgba(124,58,237,0.25)' : undefined,
        cursor: c.gone ? 'default' : 'pointer',
      }}
    >
      <div style={{ width: 40, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="tnum" style={{ fontSize: 17, fontWeight: 800, color: '#8A8A93' }}>
          {c.gone ? '–' : '#' + rank}
        </span>
      </div>
      <CoinTile tint={c.tint} ticker={c.ticker}>
        <span className="status-corner" style={{ borderColor: statusColor, color: statusColor }}>
          {c.status}
        </span>
      </CoinTile>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <Link to={`/coin/${c.ticker}`} className="ellipsis" style={{ fontWeight: 600, fontSize: 18, color: 'var(--text)' }} onClick={(e) => e.stopPropagation()}>
            {c.name}
          </Link>
          {rising && <RookieBadge />}
          <span style={{ flex: 'none', fontSize: 13, fontWeight: 700, color: c.moveDir === 'up' ? 'var(--green)' : 'var(--red)', opacity: c.moveDir ? 1 : 0, transition: 'opacity 0.4s ease' }}>
            {c.moveDir === 'up' ? '▲ ' + c.moveBy : c.moveDir === 'down' ? '▼ ' + c.moveBy : ''}
          </span>
          {c.isNew && (
            <span className="lm-grad tag" style={{ background: 'var(--accent)', color: '#fff' }}>
              JUST SEATED
            </span>
          )}
          {c.graduating && (
            <span style={{ position: 'relative', flex: 'none', display: 'inline-block' }}>
              {SPARKS.map(([dx, dy, bg], i) => (
                <span key={i} className="lm-spark" style={{ ['--dx' as string]: dx, ['--dy' as string]: dy, background: bg }} />
              ))}
              <span className="lm-grad tag" style={{ background: 'var(--gold)', color: 'var(--bg)' }}>
                GRADUATED
              </span>
            </span>
          )}
        </span>
        <span className="muted" style={{ fontSize: 14, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>{c.ticker}</span>
          {rising && <span style={{ color: 'var(--gold)', fontWeight: 600 }}>graduates in {timeLeft(c.grad!)}</span>}
        </span>
        <span className="tnum" style={{ display: 'flex', gap: 14, fontSize: 14 }}>
          <span title="People who traded in the last hour" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--red)' }}>
            <PersonIcon />
            {c.people}
          </span>
          <span title="Survival timer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: c.gone || c.secs < 7200 ? 'var(--red)' : 'var(--text)' }}>
            <TimerIcon />
            {c.gone ? 'died' : timeLeft(c.secs)}
            <span aria-hidden="true" className={'survived-check' + (c.survived ? ' lm-surv' : '')} style={{ opacity: c.survived ? 1 : 0 }}>
              ✓
            </span>
            <span style={{ fontSize: 12, color: 'var(--green)', opacity: c.bump ? 1 : 0, transition: 'opacity 0.4s ease' }}>{c.bump}</span>
          </span>
          <span style={{ color: change >= 0 ? 'var(--green)' : 'var(--red)' }}>{signedPct(change, 0)}</span>
        </span>
      </div>
      <div className="tnum" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, fontSize: 15, whiteSpace: 'nowrap' }}>
        <span>
          <span className="muted">OV</span> {money(c.ovNum)} <span className="muted">MC</span> {money(c.mcNum)}
        </span>
        <span>
          <span className="muted">P</span> {priceOf(c).toFixed(4)}
        </span>
      </div>
      <div aria-hidden="true" className="grad-track" style={{ opacity: c.grad === null ? 0 : 1 }}>
        <div
          style={{
            height: 5,
            borderRadius: 6,
            background: 'var(--gold)',
            width: c.grad === null ? '0%' : c.graduating ? '100%' : `${Math.round((1 - c.grad / GRAD_SECONDS) * 1000) / 10}%`,
            boxShadow: c.graduating ? '0 0 16px 2px rgba(251,191,36,0.7)' : 'none',
            transition: 'width 0.6s ease, box-shadow 0.4s ease',
          }}
        />
      </div>
    </article>
  )
}

const SPARKS: [string, string, string][] = [
  ['-34px', '-18px', '#FBBF24'],
  ['30px', '-22px', '#C084FC'],
  ['-28px', '16px', '#C084FC'],
  ['36px', '14px', '#FBBF24'],
  ['0px', '-30px', '#FBBF24'],
  ['4px', '26px', '#7C3AED'],
]
