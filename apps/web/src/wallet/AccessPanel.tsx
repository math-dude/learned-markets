import { useState } from 'react'

const NAME = /^[A-Za-z0-9_]{3,16}$/
export const nameKey = (address: string) => 'lm.username.' + address

/** Bind the chosen username to the verified wallet. Needs an open trading session. */
export async function saveUsername(username: string) {
  const response = await fetch('/api/profile', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not save your username.')
  }
}

export function UsernameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [taken, setTaken] = useState(false)
  const valid = NAME.test(value)
  return (
    <label className="username-field">
      <span>Username</span>
      <span className={'input-box' + (value && (!valid || taken) ? ' invalid' : '')}>
        <span>@</span>
        <input
          value={value}
          maxLength={16}
          placeholder="degen_frog"
          autoComplete="off"
          onChange={(e) => {
            const v = e.target.value.replace(/[^A-Za-z0-9_]/g, '')
            onChange(v)
            setTaken(false)
            if (NAME.test(v))
              fetch('/api/profile/available?username=' + encodeURIComponent(v))
                .then((r) => r.json())
                .then((r) => setTaken(!r.available))
                .catch(() => {})
          }}
        />
      </span>
      <small className={taken || (value && !valid) ? 'red' : 'muted'}>
        {taken ? '@' + value + ' is taken.' : value && !valid ? '3–16 letters, numbers or _' : 'Shown to other traders instead of your wallet address.'}
      </small>
    </label>
  )
}
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
  const [username, setUsername] = useState(() => localStorage.getItem(nameKey(address)) ?? '')
  const [feedback, setFeedback] = useState('')
  const [step, setStep] = useState('')
  async function verify() {
    setFeedback('')
    if (!NAME.test(username)) {
      setFeedback('Pick a username first.')
      return
    }
    localStorage.setItem(nameKey(address), username)
    setStep('Checking your participant badge…')
    try {
      const eligibility = await gateRequest<{ eligible: boolean }>('wallets/' + address + '/eligibility')
      let rid = requestId
      if (!eligibility.eligible && !rid) {
        setStep('Sign the enrollment message in Privy…')
        const ch = await wallet.challenge('enroll')
        setStep('Submitting your enrollment…')
        const result = await gateRequest<{ requestId: string }>('enrollments', ch)
        rid = result.requestId
        setId(rid)
        localStorage.setItem(key, rid)
      }
      if (rid && !eligibility.eligible) {
        const path = 'enrollments/' + encodeURIComponent(rid)
        // Surfpool demo approves automatically; wait for the badge to be issued.
        let ready = false
        for (let i = 0; i < 60 && !ready; i++) {
          setStep('Issuing your trader badge…')
          const req = await gateRequest<{ status: string; operation: { step: string } | null }>(path)
          if (req.status === 'rejected') {
            localStorage.removeItem(key)
            setId(null)
            setFeedback('The operator declined this request.')
            return
          }
          ready = req.operation?.step === 'await_registration'
          if (!ready) await new Promise((r) => setTimeout(r, 1500))
        }
        if (!ready) {
          setFeedback('Still waiting for approval. Try Continue in a minute.')
          return
        }
        const tx = await gateRequest<{ transactionBase64: string }>(path + '/registration-transaction', {})
        setStep('Sign the registration in Privy…')
        await wallet.send(tx.transactionBase64, () => setStep('Confirming registration on Solana…'))
        const report = await gateRequest<{ eligibility: { eligible: boolean } }>(path + '/confirm', {})
        if (!report.eligibility.eligible) throw new Error('Registration has not confirmed yet. Press Continue.')
      }
      setStep('Sign the session message in Privy…')
      const challenge = await wallet.challenge('session')
      setStep('Opening your trading session…')
      await gateRequest('sessions', challenge)
      setStep('Saving @' + username + '…')
      await saveUsername(username)
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
      <h2>Create your trader</h2>
      <UsernameField value={username} onChange={setUsername} />
      <small className="muted">
        Your Privy wallet signs every order. On this demo network your account is approved and funded automatically.
      </small>
      <button type="button" className="btn-primary" disabled={!wallet.ready || !!step} onClick={verify}>
        {step || (requestId ? 'Continue' : 'Create trader')}
      </button>
      {feedback && <span role="status">{feedback}</span>}
    </div>
  )
}
