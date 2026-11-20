import { useState } from 'react'
import { GateError, gateRequest, useWallet, type Wallet } from './access'

export function AccessPanel({ connect }: { connect: () => Promise<unknown> }) {
  const wallet = useWallet()
  if (!wallet)
    return (
      <p className="muted">
        Wallet sign-in is unavailable. This market is read-only until a Privy app is configured.
      </p>
    )
  if (!wallet.address)
    return (
      <button className="btn-primary" disabled={!wallet.ready} onClick={wallet.login}>
        Sign in with Privy
      </button>
    )
  return <Enrollment key={wallet.address} wallet={wallet} address={wallet.address} connect={connect} />
}

function Enrollment({
  wallet,
  address,
  connect,
}: {
  wallet: Wallet
  address: string
  connect: () => Promise<unknown>
}) {
  const key = 'lm.' + (import.meta.env.VITE_LM_NETWORK || 'surfpool') + '.enrollment.' + address
  const [requestId, setId] = useState(() => localStorage.getItem(key))
  const [feedback, setFeedback] = useState('')
  const [step, setStep] = useState('')
  async function verify() {
    setFeedback('')
    setStep('Checking your participant badge…')
    try {
      const eligibility = await gateRequest<{ eligible: boolean }>('wallets/' + address + '/eligibility')
      if (!eligibility.eligible && !requestId) {
        setStep('Sign the enrollment message in Privy…')
        const ch = await wallet.challenge('enroll')
        setStep('Submitting your enrollment…')
        const result = await gateRequest<{ requestId: string }>('enrollments', ch)
        setId(result.requestId)
        localStorage.setItem(key, result.requestId)
        setFeedback('Enrollment requested. An operator must approve your participant badge.')
        return
      }
      if (requestId && !eligibility.eligible) {
        setStep('Checking enrollment status…')
        const path = 'enrollments/' + encodeURIComponent(requestId)
        const req = await gateRequest<{ status: string; operation: { step: string } | null }>(path)
        if (req.status === 'rejected') {
          localStorage.removeItem(key)
          setId(null)
          setFeedback('The operator declined this request.')
          return
        }
        if (req.operation?.step !== 'await_registration') {
          setFeedback('Enrollment status · ' + (req.operation?.step || req.status))
          return
        }
        const tx = await gateRequest<{ transactionBase64: string }>(path + '/registration-transaction', {})
        setStep('Sign the registration in Privy…')
        await wallet.send(tx.transactionBase64, () => setStep('Confirming registration on Solana…'))
      }
      if (requestId) {
        const report = await gateRequest<{ eligibility: { eligible: boolean } }>(
          'enrollments/' + requestId + '/confirm',
          {},
        )
        if (!report.eligibility.eligible)
          throw new Error('Registration has not confirmed yet. Check enrollment again.')
      }
      setStep('Sign the session message in Privy…')
      const challenge = await wallet.challenge('session')
      setStep('Opening your trading session…')
      await gateRequest('sessions', challenge)
      await connect()
      localStorage.removeItem(key)
      setId(null)
    } catch (err) {
      if (err instanceof GateError && err.code === 'UnknownRequest') {
        localStorage.removeItem(key)
        setId(null)
        setFeedback('The saved request belongs to a previous validator. Request enrollment here.')
      } else setFeedback(err instanceof Error ? err.message : 'Wallet verification failed.')
    } finally {
      setStep('')
    }
  }
  return (
    <div className="card">
      <small>Solana wallet · {import.meta.env.VITE_LM_NETWORK || 'surfpool'}</small>
      <code>{address}</code>
      <small>
        Registration and signed intents use test SOL for fees and rent.
        {(import.meta.env.VITE_LM_NETWORK || 'surfpool') === 'surfpool' &&
          ' Privy displays “devnet” for this test wallet. Transactions settle on Surfpool.'}
      </small>
      <button type="button" className="btn-primary" disabled={!wallet.ready || !!step} onClick={verify}>
        {step || (requestId ? 'Check enrollment' : 'Verify wallet or request enrollment')}
      </button>
      {feedback && <span role="status">{feedback}</span>}
    </div>
  )
}
