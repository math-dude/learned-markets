# Settlement interface for the program

Written 2026-11-20 for whoever builds the settlement engine. It describes what the program must do so that it agrees, to the lamport, with the market core in `packages/core` (the code the simulator, the trainer and the backend all run). The first use is a parity test: replay a simulated episode on Surfpool and compare every balance.

Status: the core side is implemented in `packages/core/src/learned_markets_core/{clearing,ledger,market}.py`. The program side does not exist yet (`settlement.rs` still uses `NotImplementedEngine`). Everything marked **proposed** is this note's suggestion, not a team decision.

## What the program does and does not do

- **Does:** validate intents (already built), apply the fills of one batch to balances, check the arithmetic and the conservation rules below, consume the intents.
- **Does not:** compute the clearing price, hold the tick table, compute pro-rata fills, compute fee rates, or run the line, seats and timers. All of that runs off-chain in the auctioneer.
- **No token custody for now.** Balances are recorded numbers in program accounts. That is enough for parity and for the demo.

## Units

| Thing | Unit | Type |
| --- | --- | --- |
| Quantity | whole tokens (supply is 1,000,000,000 per coin) | `u64` |
| Cash | lamports | `u64` |
| Price | micro-lamports per whole token | `u64` |
| Fee rate | parts per million | `u32` |

`PRICE_SCALE = 1_000_000`. Use `u128` for every product.

**This changes the meaning of the price in `payload.rs`,** which today says "quote atoms per whole base token". At launch a coin trades near 28 lamports per token, so whole lamports are far too coarse. The byte layout stays the same; only the unit of `CurvePoint.price` becomes micro-lamports per token and `quantity` becomes whole tokens. Say so if you would rather add a scale field or bump the contents version.

## Arithmetic for one fill

Given the batch's clearing price `p`, a fill quantity `q`, and for sells a fee rate `r` in ppm:

```
buyer:   pay  = ceil(q * p / 1_000_000)
         fee  = ceil(pay * BASE_FEE_BPS / 10_000)
         cash -= pay + fee          tokens += q

seller:  recv = floor(q * p / 1_000_000)
         fee  = min(ceil(recv * r / 1_000_000), recv)
         cash += recv - fee         tokens -= q
```

- `BASE_FEE_BPS = 100`.
- Rounding is always against the trader.
- The seller's rate `r` already includes the base fee. The auctioneer computes it from the terms locked when the position was bought; the program only bounds it: `BASE_FEE_BPS * 100 <= r <= 250_000` (the 25% ceiling).
- Reject a fill with `q == 0`, a buy that would make cash negative, or a sell of more tokens than the position holds.

## The quoter's leg and conservation

The quoter is the coin's reserve. It has no intent. Its change is derived, never passed as cash:

```
net          = sum(pay over buys) - sum(recv over sells)       // may be negative
fees         = sum(fee over all fills)
to_bucket    = floor(fees * FEE_TO_BUCKET_PPM / 1_000_000)     // FEE_TO_BUCKET_PPM = 500_000
reserve_cash   += net + to_bucket
platform_cash  += fees - to_bucket
reserve_tokens += quoter_buy - quoter_sell
```

The request carries `quoter_buy` and `quoter_sell` in tokens. The program checks:

1. **Tokens:** `sum(q over buys) + quoter_buy == sum(q over sells) + quoter_sell`.
2. **Reserve stays funded:** `reserve_cash` and `reserve_tokens` never go below zero.
3. **Cash** is conserved by construction, because the reserve receives exactly what users paid minus what users received.

The fee split is computed once per `settle_batch` call. Keep a batch in one call when exact parity matters; splitting a batch across calls can move one lamport per call between the bucket and the platform.

## Checks worth doing on-chain (proposed)

These are the batch-auction rules a settlement authority could otherwise break:

- **One price per batch.** `batch_id` must be greater than the market's last settled batch, or equal with the same `clearing_price`.
- **Every limit respected.** From the intent's curve: a buy may fill at most the quantity of its first point priced at or above `p` (nothing if `p` is above its highest price); a sell at most the quantity of its last point priced at or below `p` (nothing if `p` is below its lowest price). This is the same step rule as `payload_to_window` in `packages/core/src/learned_markets_core/curves.py`.
- **One order per person per coin per batch.** Reject two intents from the same participant in one request.
- **Selling is never blocked.** There is no hold check; the fee ceiling is the only limit.

## Accounts (proposed)

| Account | Seeds | Fields |
| --- | --- | --- |
| `Market` | `["market", market_id]` | `reserve_cash`, `reserve_tokens`, `last_batch_id`, `last_price`, `live` |
| `Balance` | `["balance", participant]` | `cash` (one per person, shared across coins) |
| `Position` | `["position", market, participant]` | `tokens` |
| `Platform` | `["platform"]` | `cash` |

Instructions beyond `settle_batch`:

- `open_market(market_id, launch_fee, deployer)`: the deployer's `Balance` pays the fee; `reserve_tokens = 1_000_000_000`; `reserve_cash = floor(launch_fee / 2)`; the rest goes to `Platform`.
- `close_market(market)`: marks the coin ended. Positions in an ended market are void, and its `reserve_cash` is only recorded (where dead-coin money goes is undecided).
- `credit_balance(participant, lamports)`: admin only, refused on mainnet. Stands in for deposits until custody is decided.

## Request shape (proposed)

Extend `SettlementRequestV1` or add a V2:

```
market: Pubkey
batch_id: u64
clearing_price: u64            // micro-lamports per token
quoter_buy: u64                // tokens
quoter_sell: u64
intents: Vec<{ intent: Pubkey, contents: Vec<u8>, quantity: u64, fee_rate_ppm: u32 }>
```

The side comes from the intent's contents. `fee_rate_ppm` is ignored for buys. `MAX_SETTLEMENT_INTENTS` is 8, so the parity episode uses at most 8 traders per batch.

## Parity fixture

The simulator will write `fixtures/settlement-episode.json`:

```
{
  "constants": { "price_scale": 1000000, "base_fee_bps": 100, "fee_to_bucket_ppm": 500000 },
  "people": 6,
  "initial_cash": [ ... ],
  "launch": { "deployer": 0, "launch_fee": 100000000 },
  "batches": [
    {
      "batch_id": 1,
      "clearing_price": 27959000,
      "quoter_buy": 0,
      "quoter_sell": 1200000,
      "fills": [
        { "person": 2, "side": "buy", "curve": [[price, quantity], ...],
          "quantity": 700000, "fee_rate_ppm": 0, "pay_or_recv": 19571300, "fee": 195713 }
      ],
      "after": { "cash": [ ... ], "tokens": [ ... ],
                 "reserve_cash": 0, "reserve_tokens": 0, "platform_cash": 0 }
    }
  ]
}
```

A replay script creates the participants, credits `initial_cash`, opens the market, submits each fill's curve as a trade intent, calls `settle_batch`, and compares the accounts with `after`.

## Local tooling on chungus

- Solana CLI 4.1.2 and Surfpool 1.7.0 are installed for user `eren` (`~/.local/share/solana/install/active_release/bin`, `~/.local/bin`); Node 24 is at `~/.local/node/bin`.
- soham's Surfpool is running on `127.0.0.1:8899` with the current program. Parity should use its own instance on another port so the two do not share admin keys.
- `cargo build-sbf` plus `solana program deploy` is enough; the Anchor CLI is not required.

## Open

- The payload price unit (above).
- Whether `Position` should also store the locked exit terms so the program can recompute `fee_rate_ppm` itself.
- Where dead-coin money goes.
- Real custody: SOL vault and Token-2022 mints in place of recorded balances.
