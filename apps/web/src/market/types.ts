/**
 * Market model for the UI. Everything here is simulated client-side until the
 * onchain program and backend expose real data; see market/engine.ts.
 */

/** How the market maker is treating a coin this round. */
export type MakerStatus = 'smoothing' | 'free' | 'watch' | 'taper'

export interface Coin {
  id: number
  tint: string
  name: string
  ticker: string
  status: MakerStatus
  /** Market cap in USD. Price (SOL) is mcNum / SUPPLY. */
  mcNum: number
  /** Market cap at the start of the 24h window, for the change %. */
  openMc: number
  /** Organic volume in USD. */
  ovNum: number
  /** Survival timer, seconds. Coin dies at an epoch if it is the lowest / at zero. */
  secs: number
  /** Seconds until a rookie graduates, or null for established coins. */
  grad: number | null
  graduating: boolean
  people: number
  holders: number
  makerShare: number
  // transient animation flags
  flash: 'up' | 'down' | null
  bump: string
  gone: boolean
  survived: boolean
  isNew: boolean
  dethroned: boolean
  moveDir: 'up' | 'down' | null
  moveBy: number
}

/** A coin waiting in the Line for a seat on the Board. */
export interface LineCoin {
  id: number
  tint: string
  name: string
  ticker: string
  heat: number
  people: number
  bornAt: number
  mine?: boolean
}

export interface Holding {
  ticker: string
  size: number
  /** Average entry price, SOL. */
  entry: number
}

export interface PastCoin {
  tint: string
  name: string
  ticker: string
  size: number
  put: number
  died: string
}

export type KingPhase = 'challenge' | 'out' | 'in' | null

export interface MarketState {
  epoch: number
  epochNo: number
  showEpoch: boolean
  epochSummary: string
  streak: number

  pickDie: number | null
  pickSeat: number | null
  pickRight: number
  pickTotal: number
  pickResult: string

  newKing: boolean
  crownFlip: boolean
  phase: KingPhase
  challengerId: number | null
  headlines: string[]

  king: Coin
  coins: Coin[]
  line: LineCoin[]

  balance: number
  holdings: Holding[]
  past: PastCoin[]
}
