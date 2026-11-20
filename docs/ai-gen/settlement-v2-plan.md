# Settlement v2: build spec for the on-chain program

This is a build spec for an agent with no prior context. Time budget: 1–1.5 h. The hackathon submission is due **Fri 2026-11-20, 12:00 CST**. Speed matters more than generality. Where this spec simplifies, do not add scope back in.

## 0. Context in five lines

- Learned Markets is a memecoin exchange on Solana. Trading clears in sealed batch auctions where every order is a **curve**. User curves and one **quoter** (the learned market maker) curve clear together at **one price**.
- **Clearing runs off-chain** in Python. The program **does not recompute the clearing price**. It *settles*: it checks that the submitted fills are honest, then moves balances.
- **The quoter is the launch.** A coin's entire supply starts in the quoter's inventory, and the quoter sells it through its curve.
- **Sealed and firm:** the quoter commits a hash of its curve before the batch. Settlement reveals the curve and the program checks the hash.
- The fixed stand-ins for the learned terms are a fee in basis points, an exit fee inside a hold window, and a 2% per-person holding cap.

## 1. What exists (read these first)

| File | What it is | What to do |
|---|---|---|
| `programs/learned-markets/src/lib.rs` | Anchor 1.2.2 program, ID `nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz` | Add the new instructions |
| `src/settlement.rs` | `validate_batch` (full per-intent eligibility, hash and replay checks), the `SettlementEngine` trait, `NotImplementedEngine`, and `execute` (consumes intents after the engine runs) | **Keep `validate_batch` and `execute`.** Replace the engine. Extend the request |
| `src/payload.rs` | `TradeContents` curve: ≤16 `(price, quantity)` points; `payload_hash` | Reuse it. Add `qty_at` and a prefix decoder |
| `src/instructions/settle.rs` | `SettleBatch` accounts and handler | Rewrite the handler for v2 |
| `src/instructions/intents.rs` | `submit_intent`/`cancel_intent`; `Intent.target` is the market pubkey | Unchanged |
| `src/gate.rs` | `require_eligible(config, participant, binding, badge, now, GateMode)` | Reuse it in `deposit` |
| `src/accounting.rs` | `checked_credit`, `checked_debit` | Use them for every balance change |
| `src/state.rs`, `error.rs`, `events.rs`, `constants.rs` | Account and error definitions | Extend them. **Append** errors at the end of `GateError`, never reorder |
| `tests/program-tests/` | LiteSVM harness, a **separate Cargo workspace**. It loads `target/deploy/learned_markets.so` and reads discriminators from `target/idl/learned_markets.json`. The helpers are in `src/lib.rs` (`Env::new`, `register`, `submit_trade`, `settle_request`, `settle_intent_metas`, `ix_settle`, `settle_one`) | Extend the helpers and add `tests/settlement.rs` |

`tests/smoke.rs` currently expects `SettlementNotImplemented`. Update it.

### Toolchain gotchas (all verified)

- Put rustup first on `PATH`: `export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"`. Homebrew Rust cannot run `cargo-build-sbf`.
- Build with `anchor build` at the repo root. This produces `target/deploy/*.so` and `target/idl/*.json`.
- Test with `cd tests/program-tests && cargo test`. Keep that workspace separate: litesvm and solana-attestation pin incompatible `solana-address` versions.
- **Do not delete `target/deploy/*-keypair.json`.** They are the only copies of the program keys.
- Use npm, not bun.
- Work on a new branch `settlement-v2` off `main`.

## 2. Scope decisions (made for speed — do not revisit)

1. **Quote asset is native SOL (lamports), held by the `Market` PDA.** No SPL token for quote.
2. **The meme coin is an internal ledger balance**: `Market.total_supply` and `Position.base`. There is no SPL mint and no base withdrawal in v2. Exporting the coin to an SPL mint is a stretch goal, not part of this build.
3. Fills only change ledger numbers. Lamports move only on `deposit`/`withdraw`.
4. Partial fills are fine. Every intent in a settled batch is **consumed**, even if its fill is 0 (batch IOC).
5. The program computes fees itself from the revealed terms. The request carries only quantities.
6. Settlement is a single transaction per batch with `MAX_SETTLEMENT_INTENTS = 8` (already set). Each intent needs 7 accounts, which exceeds the legacy transaction size, so the relayer uses **v0 transactions with an address lookup table**. LiteSVM tests can stay with legacy transactions and 2–3 intents. No chunked settlement.
7. Units: `BASE_DECIMALS = 6`, and price = lamports per whole base token (10^6 atoms). `notional = q * p / 10^6`, computed in u128.

## 3. New state (`state.rs`)

```rust
/// PDA ["market", market_id]. Also the lamport vault for all quote balances.
#[account] #[derive(InitSpace)]
pub struct Market {
    pub version: u8, pub bump: u8,
    pub market_id: [u8; 32],
    #[max_len(16)] pub ticker: String,
    pub quoter: Pubkey,               // signs commit_quote
    pub total_supply: u64,            // base atoms, public, fixed at create
    pub maker_base: u64,              // quoter inventory (starts = total_supply)
    pub maker_quote: u64,             // safe bucket: sale money + maker fee share (lamports)
    pub platform_fees: u64,           // lamports
    pub total_user_quote: u64,        // Σ Position.quote, for the vault invariant
    pub batch_id: u64,                // current open batch
    pub last_price: u64,              // last clearing price; set to open_price at create
    pub fee_bps_max: u16,             // cap on fee_bps + exit_fee_bps in any reveal
    pub hold_cap_bps: u16,            // per-person base cap, 200 = 2% of total_supply
    pub platform_fee_share_bps: u16,  // share of each fee to platform; rest → maker_quote
    pub created_at: i64,
}

/// PDA ["position", market, participant]. Keyed by participant (survives wallet replacement).
#[account] #[derive(InitSpace)]
pub struct Position {
    pub version: u8, pub bump: u8,
    pub market: Pubkey, pub participant: Pubkey,
    pub base: u64, pub quote: u64,
    pub last_buy_ts: i64,
}

/// PDA ["quote", market, batch_id_le]. Kept after settlement as the audit record.
#[account] #[derive(InitSpace)]
pub struct QuoteCommit {
    pub version: u8, pub bump: u8,
    pub market: Pubkey, pub batch_id: u64,
    pub hash: [u8; 32],
    pub committed_at: i64,
    pub settled: bool,
    pub clearing_price: u64,          // written at settlement
}
```

Add the seeds `MARKET_SEED`, `POSITION_SEED` and `QUOTE_SEED`, plus `BASE_DECIMALS`, to `constants.rs`.

## 4. Instructions

### `create_market(args: { market_id, ticker, quoter, total_supply, open_price, fee_bps_max, hold_cap_bps, platform_fee_share_bps })`
- Signer: `config.admin`. Uses `init` for `Market`, and the payer is the admin.
- Sets `maker_base = total_supply` and `last_price = open_price`, with `batch_id = 0`.
- Requires `fee_bps_max ≤ 2000`, `hold_cap_bps ∈ 1..=10000`, `platform_fee_share_bps ≤ 10000`, and `total_supply > 0`.
- Emits `MarketCreated`.

### `deposit(amount: u64)`
- Accounts: wallet (signer, mut), config, participant, wallet_binding, badge (`SasBadge` struct, as in `SubmitIntent`), market (mut), position (`init_if_needed`, payer wallet), system_program.
- Requires `wallet == participant.current_wallet` and `require_eligible(..., GateMode::Admission)`.
- Does a `system_program::transfer` CPI of `amount` from the wallet to the market PDA, then `position.quote += amount` and `market.total_user_quote += amount`.
- Emits `Deposited`.

### `withdraw(amount: u64)`
- Ownership-only, like `cancel_intent`: no eligibility check, so a suspended user can always exit.
- Accounts: wallet (signer, mut), config, participant (constraint `current_wallet == wallet`), market (mut), position (mut, seeds check).
- `checked_debit` on `position.quote` and `total_user_quote`, then move the lamports directly. The program owns the market PDA: `**market.try_borrow_mut_lamports()? -= amount; **wallet... += amount`.
- Emits `Withdrawn`.

### `commit_quote(batch_id: u64, hash: [u8; 32])`
- Signer: `market.quoter` (mut payer). Uses `init` for `QuoteCommit` at `["quote", market, batch_id_le]`; a second commit fails naturally because the account already exists.
- Requires `batch_id == market.batch_id`. Sets `committed_at = now`.
- Emits `QuoteCommitted`.

### `settle_batch(request: SettlementRequestV2)` (replaces v1)

```rust
pub struct SettlementRequestV2 {
    pub version: u8,                    // = 2 (update SETTLEMENT_REQUEST_VERSION)
    pub market: Pubkey,
    pub batch_id: u64,
    pub clearing_price: u64,
    pub intents: Vec<SettlementIntentRef>, // existing type: { intent, contents }
    pub fills: Vec<u64>,                // base atoms filled, same order as intents
    pub maker_reveal: Vec<u8>,          // see §5
}
```

Accounts:
- signer `settlement_authority` (has_one on config)
- `config`
- `sas: SasBadgeShared`
- `market` (mut, seeds)
- `quote_commit` (mut, seeds `["quote", market, request.batch_id]`)

Remaining accounts: **7 per intent**, which is the existing 6 plus the `Position` at index 6, which must be writable. Change `SETTLEMENT_ACCOUNTS_PER_INTENT` to 7. In `validate_batch`, only the first 6 are read; the 7th is handled by the engine. Allow `request.intents` to be **empty**: an empty settlement just advances the batch.

Checks, in order. Each check that fails returns a distinct new error.
1. `request.version == 2`, `request.market == market.key()`, `request.batch_id == market.batch_id`, `!quote_commit.settled`, `fills.len() == intents.len()`, and `clearing_price > 0`.
2. `quote_hash(market, batch_id, maker_reveal) == quote_commit.hash` (§5). Decode the reveal and require `fee_bps + exit_fee_bps ≤ market.fee_bps_max`.
3. Run `validate_batch` unchanged; it does eligibility, ownership, hash, expiry and replay.
4. For each validated intent:
   - require `intent.created_at ≥ quote_commit.committed_at`. This proves the quoter committed before the order existed.
   - The `Position` PDA must equal `["position", market, participant]`. Deserialize it with `Account::<Position>::try_from`.
   - **Reject duplicate participants in one batch.** Use a `BTreeSet`; otherwise two `Account<Position>` copies overwrite each other.
5. Decode `TradeContents` per intent. Require `fill ≤ qty_at(curve, clearing_price)` (§6).
6. Apply user fills, with `notional_floor = q*p/1e6` and `notional_ceil = ceil(q*p/1e6)`:
   - **Buy:**
     - `fee = ceil(notional_ceil * fee_bps / 1e4)`.
     - Debit `position.quote` by `notional_ceil + fee` (fails if underfunded).
     - Credit `position.base` by `q`.
     - If `q > 0`, set `last_buy_ts = now`.
     - Require `position.base ≤ total_supply * hold_cap_bps / 1e4`.
   - **Sell:**
     - `fee = ceil(notional_floor * fee_bps / 1e4)`, plus `ceil(notional_floor * exit_fee_bps / 1e4)` when `now - last_buy_ts < hold_secs`.
     - Require `notional_floor ≥ fee`.
     - Debit `position.base` by `q`.
     - Credit `position.quote` by `notional_floor - fee`.
   - Accumulate `Σbuy_q`, `Σsell_q`, `Σbuyer_notional_paid` (ceil), `Σseller_notional_recv` (floor) and `Σfees`.
   - Keep `market.total_user_quote` exact: subtract buyer debits, add seller credits.
7. Maker fill: `net = Σbuy_q − Σsell_q`.
   - If `net > 0`, the maker sells: the reveal has a sell curve, `qty_at(sell, p) ≥ net`, and `maker_base ≥ net`, so `maker_base -= net`.
   - If `net < 0`, the maker buys `|net|`: the reveal has a buy curve with `qty_at(buy, p) ≥ |net|`, so `maker_base += |net|`.
   - Then `maker_quote = maker_quote + Σbuyer_notional_paid − Σseller_notional_recv`, computed in i128. Fail if the result is negative, because the risk allowance is 0. All rounding dust lands here, so quote is conserved exactly.
8. Fees: `platform = Σfees * platform_fee_share_bps / 1e4` (floor) goes to `platform_fees`, and the remainder goes to `maker_quote`.
9. Vault invariant (use `accounting::reconcile_backing`): `market_lamports − rent_exempt_min(market) ≥ total_user_quote + maker_quote + platform_fees`.
10. Write state: `quote_commit.settled = true`, `quote_commit.clearing_price = p`, `market.last_price = p`, `market.batch_id += 1`. Call `exit()` on every `Position`. Then `settlement::execute` consumes the intents.
11. Emit `BatchSettled { market, batch_id, clearing_price, volume: Σbuy_q.max(Σsell_q) as maker-inclusive base volume, maker_net: i64, fees: u64, fills: Vec<FillRecord { participant, side: u8, qty, quote_delta: i64, fee }> }`, and return `SettlementResultV1` via return data as today.

The cleanest structure: make `FillEngine` hold `&mut` references to the market, the commit, and the parsed positions, and implement `SettlementEngine::apply`. Change the trait signature as needed — rewrites are fine. Delete `NotImplementedEngine`, but leave the `SettlementNotImplemented` error variant in place so error codes stay stable.

**Not checked on-chain (by design):** whether `clearing_price` maximizes volume. That stays off-chain and is publicly re-checkable from `BatchSettled` plus the revealed curves.

## 5. Maker reveal encoding and hash

```
reveal = u8 version(=1)
      || u16le fee_bps || u16le exit_fee_bps || u32le hold_secs
      || u8 has_buy  || [TradeContents bytes, side must be Buy]   (if has_buy == 1)
      || u8 has_sell || [TradeContents bytes, side must be Sell]  (if has_sell == 1)
      (no trailing bytes)

quote_hash = sha256( u32le(len(D)) || D || market(32) || u64le batch_id || u32le(len(reveal)) || reveal ),
   D = b"learned-markets:quote"
```

The `TradeContents` length is self-describing (`3 + 16n`). Add `TradeContents::decode_prefix(&[u8]) -> (Self, usize)` and reuse `validate()`. Use `solana_sha256_hasher::hashv` as in `payload_hash`.

## 6. `qty_at(curve, p)` — must match Python bit for bit

Points are sorted by strictly increasing price.
- **Buy** (quantity non-increasing): if `p < p0` return `q0`; if `p > p_last` return `0`; if `p` equals a point's price, return that point's quantity; otherwise linearly interpolate between the two neighbours, rounding down.
- **Sell** (quantity non-decreasing): if `p < p0` return `0`; if `p > p_last` return `q_last`; on a point, return its quantity; otherwise interpolate, rounding down.
- Interpolation: `qa + (qb − qa)·(p − pa)/(pb − pa)` in i128. Since floor of a negative slope rounds toward −∞, compute it as `qa − ((qa−qb)·(p−pa)).div_ceil(pb−pa)` for decreasing segments, so the result is always ≤ the true value.

Add Rust unit tests in `payload.rs`. Write 6–10 vectors to `fixtures/settlement-vectors.json` so Python and TS can test against the same cases:
- `qty_at` cases
- one reveal plus its hash
- one full worked batch: inputs → expected position and market deltas

## 7. Events (`events.rs`)

`MarketCreated`, `Deposited`, `Withdrawn`, `QuoteCommitted { market, batch_id, hash, committed_at }`, and `BatchSettled` (§4.11). The off-chain market state and the quoter's observations are built only from these events.

## 8. LiteSVM tests (`tests/program-tests/tests/settlement.rs`)

Extend `src/lib.rs` with the builders `ix_create_market`, `ix_deposit`, `ix_withdraw`, `ix_commit_quote`, `quote_hash`, `reveal_bytes` and `settle_request_v2`, and add the Position meta to `settle_intent_metas`. Then cover:

1. **Happy path:**
   - Create a market with supply 1e15 and 2% cap. Alice and Bob register and deposit.
   - The quoter commits a sell-only curve.
   - Both submit buys, then settle at price p. Assert both positions, `maker_base`, `maker_quote`, `platform_fees` and the vault invariant.
   - Batch 1: Alice sells part back, so the maker buys if needed. Assert that the exit fee applies inside `hold_secs`.
2. Over-fill (`fill > qty_at`) is rejected.
3. An underfunded buyer is rejected.
4. A reveal that doesn't match the commit is rejected.
5. A fill over the hold cap is rejected.
6. A second `commit_quote` for the same batch is rejected.
7. An intent created before the commit is rejected. Warp the clock back, or submit before committing.
8. A duplicate participant in one batch is rejected.
9. An empty settlement advances `batch_id`.
10. `withdraw` works after `suspend_participant`.
11. A maker that needs more inventory than `maker_base`, or more quote than `maker_quote` (buy side with an empty safe bucket), is rejected.

Also fix `smoke.rs` and check `fixtures.rs`, which regenerates `fixtures/onchain-accounts.json`.

## 9. Done checklist

- [ ] `anchor build` is clean, and `cargo test` passes in both `programs/learned-markets` and `tests/program-tests`.
- [ ] `fixtures/settlement-vectors.json` is written.
- [ ] Deployed to surfpool at the same program ID. See the memory and `docs/ai-gen/deployment.md`. Surfpool needs `solana program deploy --use-rpc`, and the tunnel is `ssh -f -N -L 8899:127.0.0.1:8899 -L 8900:127.0.0.1:8900 soham@chungus`.
- [ ] Upgraded on devnet at the same ID. The `.so` grew, so run `solana program extend <ID> <bytes>` first if the deploy complains. If the public RPC drops writes, use `scripts/resume-buffer-write.ts`.
- [ ] Short section in `docs/ai-gen/onchain-validation.md` with the new instructions, the account table and the checks.
- [ ] Commit on `settlement-v2`. Do not push without asking.

## 10. Interface the off-chain side builds against (for reference, not this agent's job)

- **Relayer loop (TS):**
  1. After batch N settles, the quoter service (`POST /quote`) returns `{reveal}`. The relayer sends `commit_quote(N+1, quote_hash(reveal))`.
  2. Users `submit_intent` on-chain with only a hash, and send their curve `contents` to the relayer off-chain.
  3. At the cutoff, the relayer drops intents with `created_at < committed_at` (they carry over) and calls Python `POST /clear` with the user curves, the maker reveal and `market.last_price`. It gets back `{clearing_price, fills[]}`.
  4. The relayer sends `settle_batch` as a v0 transaction with an ALT and a compute-budget request of about 1.4M CU.
- **Python `clear()`:**
  - Must use the identical `qty_at` and the same units. It should pick the volume-maximizing price nearest `last_price`, using the maker curve as an ordinary participant.
  - Fills must satisfy §4.6–4.7. In particular, user fills must be chosen so that the maker's residual fits within the maker's curve at that price. Pro-rata rationing on the long side does this naturally.
