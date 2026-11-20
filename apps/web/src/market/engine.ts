/**
 * Client-side market simulation shared by every page.
 *
 * This mirrors the behaviour in design/*.html (epoch clock, deaths, seating,
 * king-of-the-hill takeovers, random trades) but keeps ONE copy of the state so
 * the board, coin page and portfolio always agree. When the Anchor program and
 * backend exist, replace the timers below with subscriptions to real data and
 * keep the public methods (fill, deposit, pickDie, ...) as the UI's API.
 */
import { Store, Timers, useStore } from '../lib/store'
import { chime } from '../lib/sound'
import { EPOCH_SECONDS, FEE, GRAD_SECONDS, SUPPLY, makeCoin, newId, priceOf, randomLineCoin, seedMarket } from './seed'
import type { Coin, Holding, LineCoin, MarketState } from './types'

type CoinPatch = Partial<Coin> | ((c: Coin) => Partial<Coin>)

export type TradeSide = 'buy' | 'sell'

class MarketEngine {
  readonly store = new Store<MarketState>(seedMarket())
  private timers = new Timers()
  private running = 0

  private get s() {
    return this.store.state
  }
  private set(patch: Partial<MarketState> | ((s: MarketState) => Partial<MarketState>)) {
    this.store.setState(patch)
  }
  private later(fn: () => void, ms: number) {
    this.timers.later(fn, ms)
  }

  /** Ref-counted so StrictMode's double mount doesn't double the timers. */
  start() {
    if (this.running++ > 0) return
    this.timers.every(() => this.tick(), 1000)
    this.timers.every(() => this.randomTrade(), 1300)
    this.later(() => this.set({ newKing: true }), 2000)
    this.later(() => this.set({ newKing: false }), 6000)
    this.later(() => this.takeover(), 18000)
    this.timers.every(() => this.takeover(), 40000)
  }

  stop() {
    if (--this.running > 0) return
    this.timers.clear()
  }

  // ───────────────────────── lookups ─────────────────────────

  findCoin(ticker: string, s = this.s): Coin | undefined {
    const t = ticker.toUpperCase()
    if (s.king.ticker === t) return s.king
    return s.coins.find((c) => c.ticker === t && !c.gone)
  }

  /** Alive coins (king first) sorted by market cap. */
  seated(s = this.s): Coin[] {
    return [s.king, ...s.coins.filter((c) => !c.gone).sort((a, b) => b.mcNum - a.mcNum)]
  }

  rankOf(ticker: string, s = this.s): number {
    return this.seated(s).findIndex((c) => c.ticker === ticker.toUpperCase()) + 1
  }

  holding(ticker: string, s = this.s): Holding | undefined {
    return s.holdings.find((h) => h.ticker === ticker.toUpperCase())
  }

  private updateCoin(ticker: string, patch: CoinPatch) {
    const apply = (c: Coin) => ({ ...c, ...(typeof patch === 'function' ? patch(c) : patch) })
    this.set((s) =>
      s.king.ticker === ticker
        ? { king: apply(s.king) }
        : { coins: s.coins.map((c) => (c.ticker === ticker && !c.gone ? apply(c) : c)) },
    )
  }

  private pushHeadline(h: string) {
    this.set((s) => ({ headlines: [h, ...s.headlines].slice(0, 6) }))
  }

  // ───────────────────────── clock / epochs ─────────────────────────

  private tick() {
    const st = this.s
    const grads: number[] = []
    const coins = st.coins.map((c) => {
      if (c.gone) return c
      const n = { ...c, secs: Math.max(0, c.secs - 1) }
      if (c.grad !== null && !c.graduating) {
        n.grad = Math.max(0, c.grad - 1)
        if (n.grad === 0) {
          n.graduating = true
          grads.push(c.id)
        }
      }
      return n
    })
    if (grads.length) {
      for (const id of grads) {
        const c = coins.find((x) => x.id === id)
        if (c) this.later(() => this.pushHeadline(`${c.name} graduated`), 0)
      }
      this.later(() => {
        this.set((s) => ({ coins: s.coins.map((c) => (grads.includes(c.id) ? { ...c, grad: null, graduating: false } : c)) }))
      }, 2600)
    }
    const king = { ...st.king, secs: Math.max(0, st.king.secs - 1) }
    // The Line warms up as people trade in it.
    const line = st.line.map((l) => (Math.random() < 0.08 ? { ...l, heat: Math.min(99, l.heat + 1), people: l.people + (Math.random() < 0.5 ? 1 : 0) } : l))

    const epoch = st.epoch - 1
    if (epoch <= 0) {
      this.set({ king, line })
      this.closeEpoch(coins)
      return
    }
    this.set({ coins, king, line, epoch })
  }

  private closeEpoch(coins: Coin[]) {
    const st = this.s
    const alive = coins.filter((c) => !c.gone)
    if (!alive.length) return
    let lowest = alive[0]
    alive.forEach((c) => {
      if (c.secs < lowest.secs) lowest = c
    })
    const marked = coins.map((c) => (c.id === lowest.id ? { ...c, gone: true } : c.gone ? c : { ...c, survived: true }))

    // Seat the hottest coin in the Line.
    const hottest = [...st.line].sort((a, b) => b.heat - a.heat)[0] as LineCoin | undefined
    const seated = hottest ? this.lineToCoin(hottest) : null
    const now = Date.now()
    const line = st.line.filter((l) => l.id !== hottest?.id).concat([randomLineCoin(now)])

    const summary = (seated ? `${seated.name} seated as a rookie · ` : 'no new seats · ') + `${lowest.name} died · ${st.king.name} still king`

    // Score picks.
    const parts: string[] = []
    let right = 0
    let total = 0
    if (st.pickDie !== null) {
      total++
      const ok = st.pickDie === lowest.id
      if (ok) right++
      const picked = coins.find((c) => c.id === st.pickDie)
      parts.push(ok ? `✓ ${lowest.name} died` : `✗ ${picked?.name ?? 'your pick'} survived`)
    }
    if (st.pickSeat !== null) {
      total++
      const ok = st.pickSeat === hottest?.id
      if (ok) right++
      const picked = st.line.find((l) => l.id === st.pickSeat)
      parts.push(ok ? `✓ ${picked?.name} was seated` : `✗ ${picked?.name ?? 'your pick'} wasn’t seated`)
    }

    // Holders of a dead coin are not paid out.
    const held = st.holdings.find((h) => h.ticker === lowest.ticker)
    const holdings = held ? st.holdings.filter((h) => h !== held) : st.holdings
    const past = held
      ? [{ tint: lowest.tint, name: lowest.name, ticker: lowest.ticker, size: held.size, put: held.size * held.entry, died: `Epoch ${st.epochNo} · just now` }, ...st.past]
      : st.past

    this.set({
      coins: marked,
      line,
      epoch: EPOCH_SECONDS,
      epochNo: st.epochNo + 1,
      showEpoch: true,
      epochSummary: summary,
      streak: held ? 0 : st.streak + 1,
      holdings,
      past,
      pickResult: total ? 'Your picks: ' + parts.join(' · ') : '',
      pickRight: st.pickRight + right,
      pickTotal: st.pickTotal + total,
      pickDie: null,
      pickSeat: null,
      headlines: [
        ...(seated ? [`${seated.name} seated as a rookie`] : []),
        `${lowest.name} died at the epoch`,
        ...st.headlines,
      ].slice(0, 6),
    })
    chime(right > 0)

    this.later(() => this.set((s) => ({ coins: s.coins.map((c) => (c.survived ? { ...c, survived: false } : c)) })), 2600)
    this.later(() => {
      const kept = this.s.coins.filter((c) => !c.gone)
      if (seated) kept.splice(2, 0, { ...seated, isNew: true })
      this.set({ coins: kept })
      if (seated) {
        this.later(() => this.set((s) => ({ coins: s.coins.map((c) => (c.id === seated.id ? { ...c, isNew: false } : c)) })), 3200)
      }
    }, 900)
    this.later(() => this.set({ showEpoch: false }), 4200)
  }

  private lineToCoin(l: LineCoin): Coin {
    const mc = 6000 + Math.random() * 3000
    return makeCoin(newId(), l.tint, l.name, l.ticker, 'smoothing', 1500 + Math.random() * 800, mc, 5 + Math.random() * 10, 6 * 3600, l.people, GRAD_SECONDS)
  }

  // ───────────────────────── background trading ─────────────────────────

  private ranks(coins: Coin[]): Record<number, number> {
    const r: Record<number, number> = {}
    coins
      .slice()
      .sort((x, y) => Number(x.gone) - Number(y.gone) || y.mcNum - x.mcNum)
      .forEach((c, i) => {
        r[c.id] = i
      })
    return r
  }

  private randomTrade() {
    const alive = this.s.coins.filter((c) => !c.gone)
    if (!alive.length) return
    const pick = alive[Math.floor(Math.random() * alive.length)]
    const up = Math.random() < 0.62
    const add = up ? 60 * (2 + Math.floor(Math.random() * 6)) : 0
    const before = this.ranks(this.s.coins)
    const next = this.s.coins.map((c) =>
      c.id === pick.id
        ? {
            ...c,
            flash: up ? ('up' as const) : ('down' as const),
            bump: add ? `+${add / 60}m` : '',
            secs: c.secs + add,
            ovNum: c.ovNum + 50 + Math.random() * 400,
            mcNum: Math.max(1000, c.mcNum * (up ? 1 + 0.04 + Math.random() * 0.22 : 1 - 0.04 - Math.random() * 0.16)),
          }
        : c,
    )
    const after = this.ranks(next)
    const moved: number[] = []
    const withMoves = next.map((c) => {
      const d = before[c.id] - after[c.id]
      if (d === 0) return c
      moved.push(c.id)
      return { ...c, moveDir: d > 0 ? ('up' as const) : ('down' as const), moveBy: Math.abs(d) }
    })
    this.set({ coins: withMoves })
    if (moved.length) {
      this.later(() => this.set((s) => ({ coins: s.coins.map((c) => (moved.includes(c.id) ? { ...c, moveDir: null, moveBy: 0 } : c)) })), 1500)
    }
    this.later(() => this.set((s) => ({ coins: s.coins.map((c) => (c.id === pick.id ? { ...c, flash: null, bump: '' } : c)) })), 900)
  }

  private takeover() {
    if (this.s.phase) return
    const alive = this.s.coins.filter((c) => !c.gone).sort((x, y) => y.mcNum - x.mcNum)
    if (!alive.length) return
    const top = alive[0]
    this.set({ phase: 'challenge', challengerId: top.id })
    this.later(() => this.set({ phase: 'out' }), 1500)
    this.later(() => {
      const old = this.s.king
      const cur = this.s.coins.find((c) => c.id === top.id) ?? top
      const king: Coin = { ...cur, mcNum: Math.max(cur.mcNum, old.mcNum * 1.06), flash: null, bump: '', moveDir: null, isNew: false }
      const dethroned: Coin = { ...old, id: top.id, mcNum: Math.min(old.mcNum, cur.mcNum * 0.97), dethroned: true }
      this.set((s) => ({
        king,
        coins: s.coins.map((c) => (c.id === top.id ? dethroned : c)),
        phase: 'in',
        challengerId: null,
        crownFlip: !s.crownFlip,
        newKing: true,
        headlines: [`$${king.ticker} took the crown from $${old.ticker}`, ...s.headlines].slice(0, 6),
      }))
      this.later(() => this.set((s) => ({ phase: null, coins: s.coins.map((c) => (c.id === dethroned.id ? { ...c, dethroned: false } : c)) })), 2400)
      this.later(() => this.set({ newKing: false }), 4500)
    }, 1950)
  }

  // ───────────────────────── user actions ─────────────────────────

  pickDie(coinId: number) {
    this.set((s) => ({ pickDie: s.pickDie === coinId ? null : coinId }))
  }

  pickSeat(lineId: number) {
    this.set((s) => ({ pickSeat: s.pickSeat === lineId ? null : lineId }))
  }

  deposit(sol: number): boolean {
    if (!(sol > 0)) return false
    this.set((s) => ({ balance: s.balance + sol }))
    return true
  }

  withdraw(sol: number): boolean {
    if (!(sol > 0) || sol > this.s.balance) return false
    this.set((s) => ({ balance: s.balance - sol }))
    return true
  }

  /** Settle one of the user's orders at the round's clearing price. Returns qty filled. */
  fill(ticker: string, side: TradeSide, sol: number, price: number): number {
    const t = ticker.toUpperCase()
    const s = this.s
    const h = this.holding(t)
    if (side === 'buy') {
      const cost = sol * (1 + FEE)
      if (cost > s.balance) return 0
      const qty = Math.round(sol / price)
      const size = (h?.size ?? 0) + qty
      const entry = ((h?.size ?? 0) * (h?.entry ?? 0) + qty * price) / size
      const holdings = h ? s.holdings.map((x) => (x === h ? { ...x, size, entry } : x)) : [...s.holdings, { ticker: t, size, entry }]
      this.set({ balance: s.balance - cost, holdings })
      return qty
    }
    if (!h) return 0
    const qty = Math.min(h.size, Math.round(sol / price))
    const left = h.size - qty
    this.set({
      balance: s.balance + qty * price * (1 - FEE),
      holdings: left > 0 ? s.holdings.map((x) => (x === h ? { ...x, size: left } : x)) : s.holdings.filter((x) => x !== h),
    })
    return qty
  }

  /** A round on a coin cleared: move its price and survival timer. */
  applyRound(ticker: string, price: number, gainSecs: number, volumeSol: number, people: number) {
    this.updateCoin(ticker, (c) => ({
      mcNum: price * SUPPLY,
      secs: c.secs + gainSecs,
      ovNum: c.ovNum * 0.9995 + volumeSol * 180,
      people,
    }))
  }

  launch(name: string, ticker: string): LineCoin {
    const coin: LineCoin = { id: newId(), tint: '#1D1828', name, ticker: ticker.toUpperCase(), heat: 5, people: 1, bornAt: Date.now(), mine: true }
    this.set((s) => ({ line: [...s.line, coin], headlines: [`${name} joined the Line`, ...s.headlines].slice(0, 6) }))
    return coin
  }
}

export const market = new MarketEngine()
export { priceOf }

export function useMarket(): MarketState {
  return useStore(market.store)
}
