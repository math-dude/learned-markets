import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { BoardIcon, InfoIcon, PlusIcon, PortfolioIcon, SearchIcon } from './icons'
import { CoinTile } from './CoinBits'

const NAV = [
  { to: '/', label: 'Board', icon: BoardIcon, end: true },
  { to: '/portfolio', label: 'Portfolio', icon: PortfolioIcon },
  { to: '/proof', label: 'Pump vs us', icon: InfoIcon },
]

/** The damper mark: an oscillation settling to rest. */
export function DamperMark() {
  return (
    <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#15101f" />
      <path
        d="M7 22c1.6-9 3.4-12 5.2-12 3.2 0 2.6 17 6 17 2.6 0 2.4-9.5 5-9.5 1.9 0 2.1 4.2 4 4.2 1.3 0 2.6-1.2 5.8-1.5"
        fill="none"
        stroke="#a78bfa"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ShellFrame({ bar, children }: { bar: ReactNode; children: ReactNode }) {
  return (
    <div className="shell">
      <nav aria-label="Main" className="sidenav">
        <NavLink to="/" aria-label="damper home" className="sidenav-logo">
          <DamperMark />
        </NavLink>
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
        {bar}
        {children}
      </div>
    </div>
  )
}

type SearchCoin = { key: string; name: string; ticker: string; tint: string; where: string; to: string; image?: string }

export function Search({ coins }: { coins: SearchCoin[] }) {
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
    return coins.filter((r) => r.name.toLowerCase().includes(t) || r.ticker.toLowerCase().includes(t)).slice(0, 8)
  }, [q, coins])

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
          placeholder="Search for coins…"
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
              <CoinTile tint={r.tint} ticker={r.ticker} size={32} fontSize={10} image={r.image} />
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
