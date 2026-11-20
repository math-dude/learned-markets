import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { gradientFor } from '../components/CoinBits'
import type { ChainState } from '../wallet/ChainMarket'

type Market = ChainState['markets'][number]
type Node = { id: string; x: number; y: number; vx: number; vy: number; r: number; tr: number; el?: HTMLElement | null }
type Shown = Market & { dying?: boolean; fresh?: boolean }

const STAGE_CLASS: Record<string, string> = { Line: 'line', Rookie: 'rookie', Regular: 'regular' }
const R = 52
const later = (fn: () => void, spread = 1700) => window.setTimeout(fn, Math.random() * spread)
const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n))

export function BubbleArena({ state, height = 440 }: { state: ChainState; height?: number }) {
  const navigate = useNavigate()
  const box = useRef<HTMLDivElement>(null)
  const fx = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<string, Node>())
  const els = useRef(new Map<string, HTMLElement>())
  const lastPos = useRef(new Map<string, { x: number; y: number; r: number }>())
  const size = useRef({ w: 900, h: height })
  const seenRounds = useRef(new Map<string, number>())
  const seenFills = useRef(new Set<string>())
  const seenFlows = useRef(new Set<string>())
  const first = useRef(true)
  const [shown, setShown] = useState<Shown[]>([])
  const live = state.markets.filter((m) => m.live)

  // Keep a display list that lets ended coins linger long enough to burst.
  useEffect(() => {
    setShown((prev) => {
      const ids = new Set(live.map((m) => m.address))
      const prevIds = new Set(prev.map((m) => m.address))
      const next: Shown[] = live.map((m) => ({ ...m, fresh: !first.current && !prevIds.has(m.address) }))
      for (const p of prev) if (!ids.has(p.address) && !p.dying) next.push({ ...p, dying: true })
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  useEffect(() => {
    const dying = shown.filter((m) => m.dying)
    if (!dying.length) return
    const t = window.setTimeout(() => {
      setShown((prev) => prev.filter((m) => !m.dying))
      for (const m of dying) nodes.current.delete(m.address)
    }, 1400)
    return () => window.clearTimeout(t)
  }, [shown])

  // Target radius follows on-chain liquidity (reserve cash), with a floor so new coins are visible.
  const maxLiq = Math.max(1, ...live.map((m) => Number(m.reserve_cash)))
  const target = (m: Market) => 18 + 34 * Math.sqrt(Number(m.reserve_cash) / maxLiq)

  useLayoutEffect(() => {
    const { w, h } = size.current
    for (const m of shown) {
      let n = nodes.current.get(m.address)
      if (!n) {
        const angle = Math.random() * Math.PI * 2
        n = {
          id: m.address,
          x: w / 2 + Math.cos(angle) * w * 0.45,
          y: h / 2 + Math.sin(angle) * h * 0.45,
          vx: 0,
          vy: 0,
          r: first.current ? target(m) : 2,
          tr: target(m),
        }
        nodes.current.set(m.address, n)
      }
      n.tr = m.dying ? n.r : target(m)
    }
  })

  // Physics: gentle pull to the centre, soft collisions, a little drift.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const { w, h } = size.current
      const list = [...nodes.current.values()]
      const t = performance.now() / 1000
      for (const n of list) {
        n.r += (n.tr - n.r) * 0.07
        n.vx += (w / 2 - n.x) * 0.0006 + Math.sin(t * 0.7 + n.x * 0.01) * 0.02
        n.vy += (h / 2 - n.y) * 0.0011 + Math.cos(t * 0.6 + n.y * 0.01) * 0.02
      }
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]
          const b = list[j]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const d = Math.hypot(dx, dy) || 0.01
          const min = a.r + b.r + 6
          if (d < min) {
            const push = ((min - d) / d) * 0.18
            a.vx -= dx * push
            a.vy -= dy * push
            b.vx += dx * push
            b.vy += dy * push
          }
        }
      for (const n of list) {
        n.vx *= 0.86
        n.vy *= 0.86
        n.x = Math.min(w - n.r, Math.max(n.r, n.x + n.vx))
        n.y = Math.min(h - n.r, Math.max(n.r, n.y + n.vy))
        lastPos.current.set(n.id, { x: n.x, y: n.y, r: n.r })
        n.el = els.current.get(n.id)
        // Transform only: no layout work per frame.
        if (n.el) n.el.style.transform = `translate3d(${(n.x - R).toFixed(1)}px, ${(n.y - R).toFixed(1)}px, 0) scale(${(n.r / R).toFixed(3)})`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => (size.current = { w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── effects ──
  const particle = (cls: string, x: number, y: number, text?: string) => {
    const layer = fx.current
    if (!layer) return null
    const p = document.createElement('i')
    p.className = 'fx ' + cls
    if (text) p.textContent = text
    p.style.left = x + 'px'
    p.style.top = y + 'px'
    layer.appendChild(p)
    return p
  }
  const pulse = (id: string, side: 'buy' | 'sell' | 'gold', qty?: number) => {
    const pos = lastPos.current.get(id)
    const n = nodes.current.get(id)
    if (!pos || !n?.el) return
    n.el.animate(
      [
        { boxShadow: `0 0 0 0 var(--${side === 'gold' ? 'gold' : side === 'buy' ? 'green' : 'red'})` },
        { boxShadow: `0 0 0 14px transparent` },
      ],
      { duration: 700, easing: 'ease-out' },
    )
    n.vx += (Math.random() - 0.5) * 3
    n.vy += side === 'buy' ? -2.5 : 2.5
    if (qty) {
      const p = particle('fx-qty ' + side, pos.x, pos.y - pos.r, (side === 'buy' ? '+' : '−') + short(qty))
      p?.animate(
        [
          { transform: 'translate(-50%, 0) scale(.7)', opacity: 0 },
          { transform: 'translate(-50%, -14px) scale(1)', opacity: 1, offset: 0.2 },
          { transform: 'translate(-50%, -46px) scale(1)', opacity: 0 },
        ],
        { duration: 1300, easing: 'cubic-bezier(.2,.7,.3,1)' },
      ).finished.then(() => p.remove())
    }
  }
  const burst = (x: number, y: number, colors: string[], count = 14, spread = 70) => {
    for (let i = 0; i < count; i++) {
      const p = particle('fx-spark', x, y)
      if (!p) return
      p.style.background = colors[i % colors.length]
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4
      const d = spread * (0.6 + Math.random() * 0.6)
      p.animate(
        [
          { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
          { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(.2)`, opacity: 0 },
        ],
        { duration: 800 + Math.random() * 400, easing: 'cubic-bezier(.1,.8,.3,1)' },
      ).finished.then(() => p.remove())
    }
  }
  const stream = (from: string, to: string, delay: number) => {
    const a = lastPos.current.get(from)
    const b = lastPos.current.get(to)
    if (!a || !b) return
    for (let i = 0; i < 7; i++) {
      const p = particle('fx-coin', a.x, a.y)
      if (!p) return
      const mx = (a.x + b.x) / 2 + (Math.random() - 0.5) * 120
      const my = Math.min(a.y, b.y) - 40 - Math.random() * 60
      p.animate(
        [
          { transform: 'translate(-50%,-50%) scale(.4)', left: a.x + 'px', top: a.y + 'px', opacity: 0 },
          { transform: 'translate(-50%,-50%) scale(1)', left: mx + 'px', top: my + 'px', opacity: 1, offset: 0.5 },
          { transform: 'translate(-50%,-50%) scale(.5)', left: b.x + 'px', top: b.y + 'px', opacity: 0.9 },
        ],
        { duration: 1100, delay: delay + i * 70, easing: 'cubic-bezier(.45,0,.3,1)', fill: 'backwards' },
      ).finished.then(() => {
        p.remove()
        if (i === 6) pulse(to, 'gold')
      })
    }
  }

  useEffect(() => {
    const initial = first.current
    first.current = false
    // Trades: prefer per-batch rounds, fall back to confirmed fills.
    if (state.rounds?.length) {
      for (const r of state.rounds) {
        const seen = seenRounds.current.get(r.market) ?? -1
        if (r.batch <= seen) continue
        seenRounds.current.set(r.market, r.batch)
        if (initial) continue
        const buys = Number(r.buys)
        const sells = Number(r.sells)
        later(() => {
          if (buys) pulse(r.market, 'buy', buys)
          if (sells) window.setTimeout(() => pulse(r.market, 'sell', sells), 220)
        })
      }
    } else {
      for (const f of state.fills) {
        if (seenFills.current.has(f.intent)) continue
        seenFills.current.add(f.intent)
        if (!initial) later(() => pulse(f.market, f.side === 'buy' ? 'buy' : 'sell', Number(f.quantity)))
      }
    }
    // Launch confetti.
    if (!initial)
      for (const m of shown)
        if (m.fresh)
          later(() => {
            const pos = lastPos.current.get(m.address)
            if (pos) burst(pos.x, pos.y, ['#fbbf24', '#c084fc', '#22d3ee', '#f472b6'], 16, 80)
          }, 600)
    // Dead-coin liquidity streaming into survivors.
    for (const f of state.flows ?? []) {
      const key = f.market + ':' + f.batch
      if (seenFlows.current.has(key)) continue
      seenFlows.current.add(key)
      if (initial) continue
      const pos = lastPos.current.get(f.market)
      if (pos) burst(pos.x, pos.y, ['#fb7185', '#fbbf24', '#71717a'], 22, 90)
      f.survivors.forEach((s, i) => stream(f.market, s.address, 250 + i * 160))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, shown])

  return (
    <div className="arena" ref={box} style={{ height }}>
      <div className="arena-grid" />
      {shown.map((m) => {
        const danger = m.stage !== 'Line' && m.survival !== null && m.survival < 25
        return (
          <button
            key={m.address}
            className={
              'bubble ' +
              (STAGE_CLASS[m.stage] ?? '') +
              (m.dying ? ' dying' : '') +
              (m.fresh ? ' fresh' : '') +
              (danger ? ' danger' : '')
            }
            ref={(el) => {
              if (el) els.current.set(m.address, el)
              else els.current.delete(m.address)
            }}
            onClick={() => !m.dying && navigate('/coin/' + m.address)}
            title={m.name + ' · $' + m.ticker}
          >
            <span className="bubble-face" style={{ background: gradientFor(m.ticker) }}>
              {m.image ? <img src={m.image} alt="" draggable={false} /> : <b>{m.ticker.slice(0, 4)}</b>}
            </span>
            <span className="bubble-tag">${m.ticker}</span>
            {m.dying && <span className="bubble-rip">{m.ended_reason ?? 'CUT'}</span>}
          </button>
        )
      })}
      <div className="arena-fx" ref={fx} />
      {!shown.length && <div className="arena-empty">Waiting for the first launch…</div>}
    </div>
  )
}
