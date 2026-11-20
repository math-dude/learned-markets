import { useCallback, useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useWallet } from '../wallet/access'

export interface PaperCoin {
  coin_id: number
  name: string
  ticker: string
  stage: 'line' | 'rookie' | 'regular'
  price: number
  heat: number
  timer: number
  holders: number
  cap_tokens: number
  reserve_cash: number
  early_exit_fee: number
  size_fee_per_pct_supply: number
  hold_half_life_batches: number
}

interface Trade {
  batch_id: number
  coin_id: number
  ticker: string
  side: 'buy' | 'sell'
  quantity: number
  price: number
  fee: number
}

type Receipt = { ticker: string; batch_id: number } & (
  { kind: 'order'; side: 'buy' | 'sell'; quantity: number; price: number | null; fee: number } | { kind: 'launch'; opened: boolean }
)

interface PaperAccount {
  cash: number
  positions: Record<string, number>
  pending_coins: number[]
  pending_launch: string | null
  receipts: Receipt[]
}

export interface Snapshot {
  batch_id: number
  closes_at: number
  coins: PaperCoin[]
  access: 'sandbox' | 'solana'
  account: PaperAccount | null
  trades: Trade[]
  commitment: string
  launch_fee: number
  base_fee_bps: number
  epoch_batches: number
  supply: number
}

async function request<T = Snapshot>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/' + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin', cache: 'no-store', signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body && JSON.stringify(body),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(typeof error.detail === 'string' ? error.detail : 'The paper market could not complete this request.')
  }
  return response.json()
}

export function usePaperConnection() {
  const [data, setData] = useState<Snapshot | null>(null)
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState(false)
  const wallet = useWallet()
  const revision = useRef(0)
  const sending = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let delay = 750
    const poll = async () => {
      const started = revision.current
      try {
        if (!sending.current) {
          const snapshot = await request('market', undefined, controller.signal)
          delay = snapshot.access === 'solana' ? 3500 : 750
          if (!controller.signal.aborted && started === revision.current) {
            setData(snapshot)
            setOffline(false)
          }
        }
      } catch {
        if (!controller.signal.aborted && started === revision.current) setOffline(true)
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, delay)
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [])

  const post = useCallback(async (path: string, body: object) => {
    if (sending.current) throw new Error('A request is already pending.')
    revision.current++
    sending.current = true
    setBusy(true)
    try {
      let payload = body
      let recoveryKey = ''
      if (data?.access === 'solana' && (path === 'orders' || path === 'launches')) {
        if (!wallet?.address) throw new Error('Connect your attested wallet to sign this action.')
        recoveryKey = JSON.stringify(['lm.' + (import.meta.env.VITE_LM_NETWORK || 'surfpool') + '.pending', wallet.address, path, body])
        let intent = sessionStorage.getItem(recoveryKey)
        if (!intent) {
          const prepared = await request<{ intent: string; transactionBase64: string }>(path + '/prepare', body)
          await wallet.send(prepared.transactionBase64, () => sessionStorage.setItem(recoveryKey, prepared.intent))
          intent = prepared.intent
        }
        payload = { ...body, intent }
      }
      const snapshot = await request(path, payload)
      if (recoveryKey) sessionStorage.removeItem(recoveryKey)
      setData(snapshot)
      setOffline(false)
      return snapshot
    } finally {
      sending.current = false
      setBusy(false)
    }
  }, [data?.access, wallet])
  return { data, busy, offline, post }
}

export type Room = ReturnType<typeof usePaperConnection> & { data: Snapshot }
export const useRoom = () => useOutletContext<Room>()
export const sol = (lamports: number) => (lamports / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 })
export const unitPrice = (micro: number) => (micro / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })
