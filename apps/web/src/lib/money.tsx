import { useSyncExternalStore } from 'react'

/** Platform-wide display currency. Amounts are kept in lamports; this only changes how they read. */
type Unit = 'SOL' | 'USD'
const KEY = 'damper.currency'
const state = { unit: (localStorage.getItem(KEY) === 'USD' ? 'USD' : 'SOL') as Unit, rate: 0 }
const listeners = new Set<() => void>()
let version = 0
const changed = () => {
  version += 1
  listeners.forEach((notify) => notify())
}

export function setUnit(unit: Unit) {
  state.unit = unit
  localStorage.setItem(KEY, unit)
  changed()
}

/** Latest SOL price in USD from the backend; USD display waits for the first one. */
export function setRate(rate?: number | null) {
  if (rate && rate !== state.rate) {
    state.rate = rate
    changed()
  }
}

function format(lamports: number, digits: number | undefined, signed: boolean) {
  const usd = state.unit === 'USD' && state.rate > 0
  const amount = (Math.abs(lamports) / 1e9) * (usd ? state.rate : 1)
  const sign = lamports < 0 ? '−' : signed && lamports > 0 ? '+' : ''
  if (usd) {
    const places = amount >= 1000 ? 0 : amount >= 1 || amount === 0 ? 2 : 4
    return sign + '$' + amount.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, places), maximumFractionDigits: places })
  }
  return sign + amount.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, digits ?? 3), maximumFractionDigits: digits ?? 3 }) + ' SOL'
}

/** Subscribe a component to the display currency and get the formatters. */
export function useMoney() {
  useSyncExternalStore(
    (notify) => {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    () => version,
  )
  return {
    unit: state.unit === 'USD' && state.rate > 0 ? ('USD' as Unit) : ('SOL' as Unit),
    money: (lamports: number, digits?: number) => format(lamports, digits, false),
    signed: (lamports: number, digits?: number) => format(lamports, digits, true),
  }
}

export function CurrencySwitch() {
  const { unit } = useMoney()
  return (
    <div className="currency-switch" role="group" aria-label="Display currency">
      {(['SOL', 'USD'] as const).map((u) => (
        <button key={u} type="button" aria-pressed={unit === u} onClick={() => setUnit(u)}>
          {u}
        </button>
      ))}
    </div>
  )
}
