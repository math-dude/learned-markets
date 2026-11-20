import { createContext, useContext } from 'react'

export interface Wallet {
  ready: boolean
  address?: string
  login: () => void
  logout: () => Promise<void>
  challenge: (action: 'session' | 'enroll') => Promise<{ challengeId: string; signature: string }>
  send: (transaction: string, onSigned?: () => void) => Promise<string>
}

export const WalletContext = createContext<Wallet | null>(null)
export const useWallet = () => useContext(WalletContext)

export class GateError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

export async function gateRequest<T>(path: string, body?: object, method?: string): Promise<T> {
  const response = await fetch('/v1/' + path, {
    method: method ?? (body ? 'POST' : 'GET'), credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(path === 'wallet-transactions' ? 45_000 : 15_000),
  })
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new GateError(data.error, data.message || 'The attestation service is unavailable.')
  return data as T
}
