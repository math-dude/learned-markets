import type { Coin, LineCoin, MakerStatus, MarketState } from './types'

export const SUPPLY = 1e8
export const EPOCH_SECONDS = 75
export const GRAD_SECONDS = 6 * 3600
export const OWNERSHIP_CAP_SOL = 5
export const FEE = 0.003

export const priceOf = (c: { mcNum: number }) => c.mcNum / SUPPLY

export const STATUS_COLORS: Record<MakerStatus, string> = {
  smoothing: 'var(--violet)',
  free: 'var(--muted)',
  watch: 'var(--gold)',
  taper: 'var(--red)',
}

export const STATUS_HELP: Record<MakerStatus, string> = {
  smoothing: "The maker is taking part of each round's leftover, so one big order moves the price less.",
  free: 'The maker is stepping back. Price moves on buys and sells alone.',
  watch: 'The maker is watching this coin for one-sided flow and may start smoothing.',
  taper: 'The maker is winding down support. Without new traders this coin is likely to die.',
}

const TINTS = ['#2C2528', '#26262B', '#2D2A24', '#26282E', '#2B2925', '#23272B', '#25282C']
export const tintFor = (i: number) => TINTS[i % TINTS.length]

let nextId = 1000
export const newId = () => nextId++

export function makeCoin(
  id: number,
  tint: string,
  name: string,
  ticker: string,
  status: MakerStatus,
  ov: number,
  mc: number,
  changePct: number,
  secs: number,
  people: number,
  grad: number | null = null,
): Coin {
  return {
    id, tint, name, ticker, status, secs, grad, people,
    mcNum: mc,
    openMc: mc / (1 + changePct / 100),
    ovNum: ov,
    holders: people * 4 + Math.round(mc / 1000),
    makerShare: status === 'smoothing' ? 18 : status === 'watch' ? 8 : status === 'taper' ? 4 : 0,
    graduating: false, flash: null, bump: '', gone: false, survived: false,
    isNew: false, dethroned: false, moveDir: null, moveBy: 0,
  }
}

const NAME_POOL: [string, string][] = [
  ['Office Cat', 'OFC'], ['Wet Sock', 'SOCK'], ['Lil Chair', 'CHR'], ['Soup Dog', 'SOUP'],
  ['Angry Bean', 'BEAN'], ['Sir Waffle', 'WAFL'], ['Moth Lamp', 'MOTH'], ['Bread Cat', 'LOAF'],
  ['Cool Rock', 'ROCK'], ['Tax Duck', 'DUCK'], ['Gym Frog', 'GYMF'], ['Mall Goose', 'MALL'],
]
let poolIdx = 5

export function randomLineCoin(now: number): LineCoin {
  const [name, ticker] = NAME_POOL[poolIdx++ % NAME_POOL.length]
  return { id: newId(), tint: tintFor(poolIdx), name, ticker, heat: 4 + Math.floor(Math.random() * 12), people: 2 + Math.floor(Math.random() * 6), bornAt: now }
}

export function seedMarket(): MarketState {
  const now = Date.now()
  const min = 60_000
  return {
    epoch: EPOCH_SECONDS,
    epochNo: 413,
    showEpoch: false,
    epochSummary: '',
    streak: 3,
    pickDie: null, pickSeat: null, pickRight: 7, pickTotal: 11, pickResult: '',
    newKing: false, crownFlip: false, phase: null, challengerId: null,
    headlines: ['$DOG took the crown from $CAT', 'Sad Frog Jr joined the Line', 'Lil Mop died at the epoch', 'Office Fish graduated', 'Wet Sock joined the Line'],
    king: makeCoin(0, '#2D2A24', 'Dog in Hat', 'DOG', 'smoothing', 84_000, 412_000, 38, 11 * 3600 + 1200, 340),
    coins: [
      makeCoin(1, '#2C2528', 'Cat in Box', 'CAT', 'smoothing', 61_000, 310_000, 9, 12 * 3600 + 300, 288),
      makeCoin(2, '#26262B', 'Pixel Pepe', 'PXL', 'free', 22_000, 190_000, -2, 6 * 3600 + 1800, 133),
      makeCoin(3, '#2D2A24', 'Moon Toast', 'TOAST', 'smoothing', 18_000, 96_000, 21, 9 * 3600 + 300, 96, 7300),
      makeCoin(4, '#26282E', 'Grumpy Goose', 'HONK', 'watch', 7_400, 41_000, -6, 3 * 3600 + 2400, 41, 18100),
      makeCoin(5, '#2B2925', 'Tiny Horse', 'HRS', 'free', 5_100, 33_000, 4, 5 * 3600 + 120, 52),
      makeCoin(6, '#23272B', 'Office Fish', 'FSH', 'free', 3_900, 27_000, 1, 4 * 3600 + 2880, 33, 22),
      makeCoin(7, '#2D2A24', 'Banana Phone', 'BNP', 'taper', 900, 12_000, -14, 4500, 14),
      makeCoin(8, '#25282C', 'Couch Potato', 'SPUD', 'taper', 600, 9_000, -19, 95, 6),
    ],
    line: [
      { id: 101, tint: '#26262B', name: 'Sad Frog Jr', ticker: 'SFJ', heat: 71, people: 38, bornAt: now - 12 * min },
      { id: 102, tint: '#2B2925', name: 'Hat Cat', ticker: 'HAT', heat: 63, people: 31, bornAt: now - 25 * min },
      { id: 103, tint: '#25282C', name: 'Office Cat', ticker: 'OFC', heat: 44, people: 19, bornAt: now - 40 * min },
      { id: 104, tint: '#23272B', name: 'Wet Sock', ticker: 'SOCK', heat: 31, people: 12, bornAt: now - 9 * min },
      { id: 105, tint: '#2C2528', name: 'Lil Chair', ticker: 'CHR', heat: 18, people: 7, bornAt: now - 60 * min },
    ],
    balance: 12.4,
    holdings: [
      { ticker: 'CAT', size: 4210, entry: 0.00262 },
      { ticker: 'PXL', size: 1500, entry: 0.0021 },
      { ticker: 'TOAST', size: 3800, entry: 0.0008 },
      { ticker: 'BNP', size: 2100, entry: 0.0003 },
    ],
    past: [
      { tint: '#2B2925', name: 'Lil Mop', ticker: 'MOP', size: 9400, put: 0.62, died: 'Epoch 412 · 4h ago' },
      { tint: '#26282E', name: 'Sock Puppet', ticker: 'SOCK', size: 3100, put: 0.25, died: 'Epoch 398 · 2d ago' },
    ],
  }
}
