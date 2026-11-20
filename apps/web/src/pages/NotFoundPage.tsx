import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <main style={{ padding: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
      <span style={{ fontSize: 20, fontWeight: 700 }}>Page not found</span>
      <Link to="/" className="btn-primary" style={{ padding: '11px 22px' }}>
        Go to the Board
      </Link>
    </main>
  )
}
