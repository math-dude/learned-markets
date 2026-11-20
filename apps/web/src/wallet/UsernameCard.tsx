import { useState } from 'react'
import { nameKey, saveUsername, UsernameField } from './AccessPanel'

/** For traders who verified before usernames existed. */
export function UsernameCard({ address, done }: { address: string; done: () => void }) {
  const [name, setName] = useState(() => localStorage.getItem(nameKey(address)) ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="card username-card"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError('')
        try {
          await saveUsername(name)
          localStorage.setItem(nameKey(address), name)
          done()
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not save your username.')
        } finally {
          setBusy(false)
        }
      }}
    >
      <h2>Pick your username</h2>
      <UsernameField value={name} onChange={setName} />
      <button className="btn-primary" disabled={busy || !/^[A-Za-z0-9_]{3,16}$/.test(name)}>
        {busy ? 'Saving…' : 'Save username'}
      </button>
      {error && <span className="red">{error}</span>}
    </form>
  )
}
