import { Link } from 'react-router-dom'
import { LineList, PicksPanel } from '../components/LinePanels'

export function LinePage() {
  return (
    <main style={{ flex: 1, display: 'flex', flexWrap: 'wrap' }}>
      <section aria-label="The Line" style={{ flex: '999 1 560px', minWidth: 0, borderRight: '1px solid var(--border)' }}>
        <LineList />
      </section>
      <aside style={{ flex: '1 1 320px', minWidth: 0, maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px' }}>
        <PicksPanel />
        <div className="card">
          <span className="card-title">How seating works</span>
          <span className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
            New coins wait in the Line. Heat goes up as more different people trade them. At every epoch the hottest coin in the Line takes a seat on the Board as a rookie, and the seated coin with the least
            time left dies.
          </span>
          <Link to="/launch" className="btn-primary" style={{ textAlign: 'center' }}>
            Launch a meme
          </Link>
        </div>
      </aside>
    </main>
  )
}
