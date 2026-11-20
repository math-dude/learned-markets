import { useSyncExternalStore } from 'react'

/** Minimal observable state container shared by the market engine and page sims. */
export class Store<S extends object> {
  state: S
  private listeners = new Set<() => void>()

  constructor(initial: S) {
    this.state = initial
  }

  getState = (): S => this.state

  setState = (patch: Partial<S> | ((s: S) => Partial<S>)): void => {
    const p = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...p }
    this.listeners.forEach((l) => l())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export function useStore<S extends object>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.getState)
}

/** Tracks timers so a sim can be stopped cleanly (React StrictMode mounts twice). */
export class Timers {
  private intervals = new Set<ReturnType<typeof setInterval>>()
  private timeouts = new Set<ReturnType<typeof setTimeout>>()

  every(fn: () => void, ms: number): void {
    this.intervals.add(setInterval(fn, ms))
  }

  later(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.timeouts.delete(id)
      fn()
    }, ms)
    this.timeouts.add(id)
  }

  clear(): void {
    this.intervals.forEach(clearInterval)
    this.timeouts.forEach(clearTimeout)
    this.intervals.clear()
    this.timeouts.clear()
  }
}
