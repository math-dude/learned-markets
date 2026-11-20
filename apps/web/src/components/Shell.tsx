import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { clock } from '../lib/format'
import { market, useMarket } from '../market/engine'
import { BoardIcon, InfoIcon, LineIcon, PlusIcon, PortfolioIcon, SearchIcon } from './icons'
import { CoinTile } from './CoinBits'

const NAV = [
  { to: '/', label: 'Board', icon: BoardIcon, end: true },
  { to: '/line', label: 'The Line', icon: LineIcon },
  { to: '/portfolio', label: 'Portfolio', icon: PortfolioIcon },
  { to: '/how-it-works', label: 'How it works', icon: InfoIcon },
]

export function Shell() {
  useEffect(() => {
    market.start()
    return () => market.stop()
  }, [])

  return (
    <div className="shell">
      <nav aria-label="Main" className="sidenav">
        <NavLink to="/" aria-label="Learned Markets home" className="sidenav-logo" />
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} aria-label={label} title={label} className={({ isActive }) => 'sidenav-link' + (isActive ? ' active' : '')}>
            <Icon />
          </NavLink>
        ))}
        <NavLink to="/launch" aria-label="Launch a meme" title="Launch a meme" className={({ isActive }) => 'sidenav-launch' + (isActive ? ' active' : '')}>
          <PlusIcon />
        </NavLink>
      </nav>
      <div className="main-col">
        <TopBar />
        <Outlet />
      </div>
    </div>
  )
}

function TopBar() {
  const s = useMarket()
  const { pathname } = useLocation()
  const onBoard = pathname === '/'
  return (
    <header className="topbar">
      <Search />
      <span style={{ marginLeft: 'auto' }} />
      {onBoard ? (
        <span className="chip" title="Coins you hold that survived each epoch in a row">
          <span className="muted">your picks survived</span>
          <span className="tnum" style={{ fontWeight: 800, color: 'var(--violet-hi)' }}>
            {s.streak} epochs
          </span>
        </span>
      ) : (
        <span className="chip">
          <span className="muted">next epoch</span>
          <span className="tnum" style={{ fontWeight: 700, fontFamily: 'var(--mono)' }}>
            {clock(s.epoch)}
          </span>
        </span>
      )}
      <NavLink to="/portfolio" className="chip chip-strong tnum" style={{ color: 'var(--text)' }}>
        {s.balance.toFixed(2)} SOL
      </NavLink>
    </header>
  )
}

function Search() {
  const s = useMarket()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const results = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return []
    const seated = market.seated(s).map((c) => ({ key: 'c' + c.id, name: c.name, ticker: c.ticker, tint: c.tint, where: 'Board', to: `/coin/${c.ticker}` }))
    const line = s.line.map((l) => ({ key: 'l' + l.id, name: l.name, ticker: l.ticker, tint: l.tint, where: 'The Line', to: '/line' }))
    return [...seated, ...line].filter((r) => r.name.toLowerCase().includes(t) || r.ticker.toLowerCase().includes(t)).slice(0, 8)
  }, [q, s])

  const go = (to: string) => {
    navigate(to)
    setQ('')
    setOpen(false)
    inputRef.current?.blur()
  }

  return (
    <div className="search">
      <label className="search-box">
        <SearchIcon />
        <input
          ref={inputRef}
          type="search"
          placeholder="Search for coins and users..."
          aria-label="Search for coins"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls="search-results"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setSel((i) => Math.min(results.length - 1, i + 1))
            else if (e.key === 'ArrowUp') setSel((i) => Math.max(0, i - 1))
            else if (e.key === 'Enter' && results[sel]) go(results[sel].to)
            else if (e.key === 'Escape') setOpen(false)
          }}
        />
        <span className="kbd">⌘K</span>
      </label>
      {open && q.trim() && (
        <div id="search-results" role="listbox" className="search-results">
          {results.length === 0 && <span className="muted" style={{ padding: '8px 10px', fontSize: 14 }}>No coins match “{q.trim()}”</span>}
          {results.map((r, i) => (
            <a
              key={r.key}
              role="option"
              aria-selected={i === sel}
              href={r.to}
              className="search-result"
              onMouseDown={(e) => {
                e.preventDefault()
                go(r.to)
              }}
            >
              <CoinTile tint={r.tint} ticker={r.ticker} size={32} fontSize={10} />
              <span style={{ fontWeight: 600 }}>{r.name}</span>
              <span className="muted" style={{ fontSize: 13 }}>
                ${r.ticker}
              </span>
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                {r.where}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
