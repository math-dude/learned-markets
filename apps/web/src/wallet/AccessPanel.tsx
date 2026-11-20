import { useState } from 'react'
import { gateRequest, useWallet, type Wallet } from './access'

export function AccessPanel({ connect }: { connect: () => Promise<unknown> }) {
  const wallet = useWallet()
  if (!wallet) return <p className="muted">Wallet sign-in is unavailable. This market is read-only until a Privy app is configured.</p>
  if (!wallet.address) return <button className="btn-primary" disabled={!wallet.ready} onClick={wallet.login}>Sign in with Privy</button>
  return <Enrollment key={wallet.address} wallet={wallet} address={wallet.address} connect={connect} />
}

function Enrollment({ wallet, address, connect }: { wallet: Wallet; address: string; connect: () => Promise<unknown> }) {
  const key = 'lm.' + (import.meta.env.VITE_LM_NETWORK || 'surfpool') + '.enrollment.' + address
  const [requestId, setId] = useState(() => localStorage.getItem(key))
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  async function verify() {
    setBusy(true)
    try {
      const eligibility = await gateRequest<{ eligible: boolean }>('wallets/' + address + '/eligibility')
      if (!eligibility.eligible && !requestId) {
        const ch = await wallet.challenge('enroll')
        const result = await gateRequest<{ requestId: string }>('enrollments', ch)
        setId(result.requestId)
        localStorage.setItem(key, result.requestId)
        setFeedback('Enrollment requested. An operator must approve your participant badge.')
        return
      }
      if (requestId && !eligibility.eligible) {
        const path = 'enrollments/' + encodeURIComponent(requestId)
        const req = await gateRequest<{ status: string; operation: { step: string } | null }>(path)
        if (req.status === 'rejected') {
          localStorage.removeItem(key); setId(null); setFeedback('The operator declined this request.'); return
        }
        if (req.operation?.step !== 'await_registration') {
          setFeedback('Enrollment status · ' + (req.operation?.step || req.status))
          return
        }
        const tx = await gateRequest<{ transactionBase64: string }>(path + '/registration-transaction', {})
        await wallet.send(tx.transactionBase64)
      }
      if (requestId) {
        const report = await gateRequest<{ eligibility: { eligible: boolean } }>('enrollments/' + requestId + '/confirm', {})
        if (!report.eligibility.eligible) throw new Error('Registration has not confirmed yet. Check enrollment again.')
      }
      await gateRequest('sessions', await wallet.challenge('session'))
      await connect()
      localStorage.removeItem(key)
      setId(null)
    } catch (err) { setFeedback(err instanceof Error ? err.message : 'Wallet verification failed.') }
    finally { setBusy(false) }
  }
  return <div className="card"><small>Solana wallet · {import.meta.env.VITE_LM_NETWORK || 'surfpool'}</small><code>{address}</code>
    <small>Registration and signed intents need local test SOL for fees and rent.</small>
    <button type="button" className="btn-primary" disabled={!wallet.ready || busy} onClick={verify}>
      {busy ? 'Waiting for wallet or chain…' : requestId ? 'Check enrollment' : 'Verify wallet or request enrollment'}
    </button>{feedback && <span role="status">{feedback}</span>}</div>
}
