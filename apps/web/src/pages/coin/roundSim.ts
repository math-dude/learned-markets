/**
 * Per-coin batch auction ("rounds"), ported from design/coin.html.
 *
 * Every 200ms tick: ticks 1–15 collect orders, 16–22 match buys against sells,
 * 23 clears (price moves by the leftover minus what the maker absorbs), 33 resets.
 * Clearing writes the new price / survival time / user fills back to the market.
 */
import { Store, Timers } from '../../lib/store'
import { market } from '../../market/engine'
import { priceOf } from '../../market/seed'

export type Side = 'buy' | 'sell' | 'switch'
export interface Candle {
  o: number
  h: number
  l: number
  c: number
  v: number
}
export interface Fill {
  id: string
  who: string
  buy: boolean
  sol: number
  price: number
  round: number
  mine: boolean
  fresh: boolean
}
export interface Order {
  side: Side
  sol: number
  target?: string
}
export interface RoundState {
  t: number
  roundNo: number
  buys: number[]
  sells: number[]
  phase: 'collect' | 'match' | 'clear'
  result: { left: number; maker: number; move: number } | null
  candles: Candle[]
  inCandle: number
  fills: Fill[]
  order: Order | null
  orderMsg: { tag: string; msg: string } | null
  gainText: string
}

export const TICK_MS = 200
export const COLLECT_TICKS = 16
const NAMES = ['7xKq…f3', 'Bv2m…9a', 'pz8R…Lw', 'Hq4t…0c', 'mN1e…Ts', 'C9wd…k2', 'r5Ua…Qe', 'fL7y…8b', 'Wd3h…nX', 'a2Zo…Pm']
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0)

function makeCandles(price: number, changePct: number): Candle[] {
  const raw: Candle[] = []
  let p = 1
  for (let i = 0; i < 704; i++) {
    const o = p
    let h = p
    let l = p
    for (let j = 0; j < 3; j++) {
      p = p * (1 + Math.sin(i / 70) * 0.0012 + Math.sin(i / 9) * 0.0015 + (Math.random() - 0.4985) * 0.01)
      h = Math.max(h, p)
      l = Math.min(l, p)
    }
    raw.push({ o, h: h * (1 + Math.random() * 0.003), l: l * (1 - Math.random() * 0.003), c: p, v: 0.3 + Math.random() })
  }
  // Scale so the last close is today's price and the first open matches the 24h change.
  const k0 = price / p
  const tilt = Math.log(price / (1 + changePct / 100) / (raw[0].o * k0))
  return raw.map((c, i) => {
    const k = k0 * Math.exp((tilt * (703 - i)) / 703)
    return { o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k, v: c.v }
  })
}

export class RoundSim {
  readonly store: Store<RoundState>
  private timers = new Timers()
  private bias = 1
  private msgTimer: ReturnType<typeof setTimeout> | undefined
  readonly ticker: string

  constructor(ticker: string) {
    this.ticker = ticker
    const coin = market.findCoin(ticker)!
    const price = priceOf(coin)
    const roundNo = 18422
    const seedFills: Fill[] = []
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < 3; k++) {
        seedFills.push({ id: `f${r}${k}`, who: NAMES[(r * 3 + k) % NAMES.length], buy: Math.random() > 0.4, sol: 0.1 + Math.random() * 1.4, price: price * (1 - r * 0.002), round: roundNo - 1 - r, mine: false, fresh: false })
      }
    }
    this.store = new Store<RoundState>({
      t: 0,
      roundNo,
      buys: [],
      sells: [],
      phase: 'collect',
      result: null,
      candles: makeCandles(price, (coin.mcNum / coin.openMc - 1) * 100),
      inCandle: 0,
      fills: seedFills,
      order: null,
      orderMsg: null,
      gainText: '',
    })
  }

  start() {
    this.timers.every(() => this.step(), TICK_MS)
  }
  stop() {
    this.timers.clear()
    clearTimeout(this.msgTimer)
  }

  private get s() {
    return this.store.state
  }

  private flash(tag: string, msg: string, ms = 5000) {
    this.store.setState({ orderMsg: { tag, msg } })
    clearTimeout(this.msgTimer)
    this.msgTimer = setTimeout(() => this.store.setState({ orderMsg: null }), ms)
  }

  /** Queue the user's order for the current (or next, if matching) round. */
  place(order: Order) {
    if (this.s.order || order.sol <= 0) return
    const mid = this.s.phase !== 'collect'
    this.store.setState({ order })
    this.flash(mid ? 'Next round' : 'Queued', mid ? 'Round closed, your order goes in the next one' : 'Your order fills at this round’s price', 60_000)
  }

  /** Buy-side and sell-side SOL including the user's queued order. */
  totals() {
    const o = this.s.order
    return {
      b: sum(this.s.buys) + (o && o.side === 'buy' ? o.sol : 0),
      s: sum(this.s.sells) + (o && o.side !== 'buy' ? o.sol : 0),
      bc: this.s.buys.length + (o && o.side === 'buy' ? 1 : 0),
      sc: this.s.sells.length + (o && o.side !== 'buy' ? 1 : 0),
    }
  }

  private step() {
    const st = this.s
    const t = st.t + 1
    const coin = market.findCoin(this.ticker)
    if (!coin) return // died; page will show the dead state
    if (t < COLLECT_TICKS) {
      if (t === 1) this.bias = 0.75 + Math.random() * 0.6
      const nb = Math.round((0.08 + Math.random() * 0.14) * this.bias * 100) / 100
      const ns = Math.round(((0.06 + Math.random() * 0.12) / this.bias) * 100) / 100
      this.store.setState({ t, buys: [...st.buys, nb], sells: [...st.sells, ns] })
    } else if (t === COLLECT_TICKS) {
      this.store.setState({ t, phase: 'match' })
    } else if (t === 23) {
      this.clear(t, priceOf(coin), coin.people)
    } else if (t >= 33) {
      this.store.setState({ t: 0, phase: 'collect', buys: [], sells: [], result: null, gainText: '', roundNo: st.roundNo + 1 })
    } else {
      this.store.setState({ t })
    }
  }

  private clear(t: number, base: number, people: number) {
    const st = this.s
    const { b, s } = this.totals()
    const left = b - s
    const maker = Math.abs(left) * 0.4
    const move = Math.sign(left) * (Math.abs(left) - maker) * 0.004
    const price = base * (1 + move)

    let candles = st.candles.slice()
    const last = { ...candles[candles.length - 1] }
    last.c = price
    last.h = Math.max(last.h, price)
    last.l = Math.min(last.l, price)
    last.v += (sum(st.buys) + sum(st.sells)) / 8
    candles[candles.length - 1] = last
    let inCandle = st.inCandle + 1
    if (inCandle >= 3) {
      candles = [...candles.slice(1), { o: price, h: price, l: price, c: price, v: 0.05 }]
      inCandle = 0
    }

    const orders: [boolean, number][] = [...st.buys.map((x): [boolean, number] => [true, x]), ...st.sells.map((x): [boolean, number] => [false, x])]
    const fresh: Fill[] = orders
      .sort((p1, p2) => p2[1] - p1[1])
      .slice(0, 4)
      .map(([buy, sol], k) => ({ id: `r${st.roundNo}${k}`, who: NAMES[(st.roundNo * 3 + k) % NAMES.length], buy, sol, price, round: st.roundNo, mine: false, fresh: true }))

    // Distinct traders in the round extend the survival timer.
    const gain = Math.round((st.buys.length + st.sells.length) * 0.65)
    const nextPeople = Math.max(1, people + (Math.random() < 0.5 ? -1 : 1))
    market.applyRound(this.ticker, price, gain, b + s, nextPeople)

    const patch: Partial<RoundState> = { t, phase: 'clear', candles, inCandle, gainText: `+${gain}s`, result: { left, maker, move } }

    const o = st.order
    if (o) {
      patch.order = null
      let msg: string
      if (o.side === 'buy') {
        const qty = market.fill(this.ticker, 'buy', o.sol, price)
        msg = qty ? `Bought ${qty.toLocaleString()} ${this.ticker} at ${price.toFixed(5)} in round ${st.roundNo}` : 'Not enough SOL, order cancelled'
      } else if (o.side === 'sell') {
        const qty = market.fill(this.ticker, 'sell', o.sol, price)
        msg = qty ? `Sold ${qty.toLocaleString()} ${this.ticker} at ${price.toFixed(5)} in round ${st.roundNo}` : 'Nothing to sell, order cancelled'
      } else {
        const qty = market.fill(this.ticker, 'sell', o.sol, price)
        const target = o.target ? market.findCoin(o.target) : undefined
        const got = qty && target ? market.fill(target.ticker, 'buy', qty * price * 0.997, priceOf(target)) : 0
        msg = got ? `Switched ${qty.toLocaleString()} ${this.ticker} into ${got.toLocaleString()} ${target!.ticker} in round ${st.roundNo}` : 'Switch failed, order cancelled'
      }
      fresh.unshift({ id: `me${st.roundNo}`, who: 'You', buy: o.side === 'buy', sol: o.sol, price, round: st.roundNo, mine: true, fresh: true })
      this.flash(msg.includes('cancelled') ? 'Cancelled' : 'Filled', msg)
    }
    patch.fills = [...fresh, ...st.fills.map((f) => ({ ...f, fresh: false }))].slice(0, 10)
    this.store.setState(patch)
  }
}
