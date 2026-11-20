> Superseded for the current backend and parity program on 2026-11-20 by [Eren's settlement interface](design/settlement-interface.md), selected by the user. M1 token custody remains a local checkpoint. This full-market design is retained for reference.

# Settlement v2: full build spec for the on-chain market

This spec is written for a coding agent that has no other context. It covers the whole on-chain market:
- real coin and quote tokens
- the quoter as the launch
- sealed, firm batches enforced on-chain
- public per-person trading terms
- settlement split into chunks, so the participant count is unbounded
- the fee split, deployer reward and house risk allowance
- coin stages set by the board authority

It also covers the TypeScript client, the relayer and the public verifier that connect the program to the off-chain RL quoter.

The [decision log](decisions.md) is the source of truth for the mechanism. Where this spec has to pick a concrete encoding or account layout, the choice is marked **(spec choice)**. An open design question is marked **(open, implemented as …)** and is built behind a parameter, so it can change without a rewrite.

Build all of it. Nothing here is optional or a stretch goal. The milestones in §13 set the order of work, and each one ends in a tested, committed state.

---

## 0. Mechanism → chain mapping

| Decision (log, 2026-11-20) | On-chain realization |
|---|---|
| User and quoter curves clear together at one gross price | `Batch.clearing_price`. Every fill in the batch uses it |
| Volume-max price, nearest previous on ties; clearing off-chain, program only settles | The program verifies the honesty invariants (§7). Optimality is re-checked by the public verifier (§11) from the data the program emits |
| The quoter is the launch: unissued supply starts with the quoter | `create_market` mints the full supply into the market's base vault, credits it to `maker_base`, then revokes mint authority |
| Sale money goes to that coin's safe bucket | `Market.maker_quote` |
| Sealed batch; quoter commits before the batch and can't revise | `commit_batch` stores `hash(maker curve)`. Intents count only if created in the slot window after the commit. Settlement reveals the curve and checks the hash |
| Traders see their applicable terms before submitting | The terms schedule is published **in plaintext** in the same `commit_batch` call, inside bounds fixed per market |
| Learned terms apply to every fill regardless of counterparty; may depend on position and how recently they bought | The program evaluates the public schedule per person (§6) using `Position` state |
| No one may hoard (2% stand-in) | `terms.cap_bps`, bounded by `Market.bounds`. Enforced after every buy fill |
| Per-batch size cap on every curve order | `terms.per_person_batch_max`, tracked across chunks |
| Quoter budget: safe bucket + house risk allowance (0 default) | `maker_quote` plus a `risk_allowance` funded by the house |
| Maker exposure limits are configurable hyperparameters | `Market.limits` (§3) |
| Fee split: platform and quoter reserve; fees and maker P&L tracked separately | Separate counters: `platform_fees`, `maker_fee_income` and `maker_trading_quote` |
| Deployer gets a small fee cut, only after the coin is seated | `deployer_fee_bps` accrues only while `stage ∈ {Rookie, Regular}`. `claim_deployer_fees` |
| Launch fee is set by the auction network; part goes to the coin's safe bucket | `BoardConfig.launch_fee` is set by `auction_authority`. The split uses `launch_fee_maker_share_bps` |
| Line, cut and timers run off-chain and are published | `set_stage` by `board_authority`, monotone transitions, with an event |
| Money left by a dead coin: only recorded for now | Trading stops on Cut/Dead. Users can always withdraw. The reserve is recorded, and an admin `sweep_dead_reserve` moves it to the treasury **(open, implemented as sweep to treasury)** |
| One verified account, one active wallet | The existing gate. `Position` is keyed by **participant**, so balances survive wallet replacement |

---

## 1. Existing code (read before writing anything)

- `programs/learned-markets/src/`: Anchor **1.2.2**, program ID `nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz`.
  - `settlement.rs`: `validate_batch` performs the per-intent checks: canonical PDAs, ownership, Open state, deadline, binding version, target, kind, payload hash, and full SAS standing eligibility via `gate::require_eligible`. `execute` consumes intents. **Reuse the per-intent validation logic.** Restructure freely around it.
  - `payload.rs`: `TradeContents` (side plus ≤16 points, canonical validation) and `payload_hash`. Reuse both.
  - `gate.rs`: `require_eligible(config, participant, binding, badge_accounts, now, GateMode::{Admission, Standing})`.
  - `instructions/mod.rs`: `SasBadge<'info>` (6 badge accounts) and `SasBadgeShared` (3 shared). Reuse both.
  - `assets.rs`: `inspect_token`, a validated token snapshot that supports classic and Token-2022. `accounting.rs`: `checked_credit/debit`, `reconcile_backing`.
  - `state.rs`: `Intent` gains a `created_slot` field (§3). This is a layout change, which is fine: devnet intents are disposable.
  - `error.rs`: **append** new `GateError` variants at the end. Never reorder or remove, because TS maps the codes.
- `tests/program-tests/`: LiteSVM harness, a **separate Cargo workspace**. It loads `target/deploy/*.so` and reads instruction discriminators and error codes from `target/idl/learned_markets.json`. The builders live in `src/lib.rs` (`Env::new`, `new_wallet`, `register`, `submit_trade`, `settle_*`). The bundled Token-2022 and ATA programs are already loaded. Classic SPL Token is also built into LiteSVM.
- `packages/attestations/src/`: working TS (Solana Kit) builders for the gate instructions, plus the payload hash. These passed a 26-step rollout on surfpool and devnet. `packages/client/` is an empty scaffold; its `AGENTS.md` asks for Codama-generated bindings from the IDL.
- `fixtures/intent-payload-vectors.json`: the pattern for cross-language vectors.

### Toolchain gotchas (verified)
- `export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"`. Homebrew Rust can't run `cargo-build-sbf`.
- Build with `anchor build` at the repo root. Test with `cargo test` in `programs/learned-markets` and in `tests/program-tests`.
- Keep `tests/program-tests` a separate workspace: litesvm pins `solana-address ~2.7`, while solana-attestation needs `^2.8`.
- **Never delete `target/deploy/*-keypair.json`.** They are the only copies of the program keys.
- Use npm, never bun.
- Work on branch `settlement-v2` off `main`. Commit per milestone. Don't push without asking.
- Token CPIs: try `anchor-spl = "=1.2.2"` with `token_interface`. If it conflicts with the pinned `spl-token-interface =2.0.0` / `spl-token-2022-interface =4.0.0`, build the instructions with those crates' `instruction::*` builders and call `invoke_signed`. Pick whichever resolves cleanly; the behaviour must be the same either way.

---

## 2. Units and conventions

- **Base (coin):** Token-2022 mint with `decimals = 6`, created by the program per market, with MetadataPointer and TokenMetadata extensions (name, symbol, uri) so wallets display it **(spec choice)**.
- **Quote:** any SPL or Token-2022 mint, fixed per market at creation. Demo: a program-independent test mint `tUSD` (decimals 6), minted by an operator script **(spec choice; wSOL also works unchanged)**.
- **Price:** quote atoms per whole base token (10^6 base atoms). This matches the `payload.rs` doc comment.
- `notional(q, p) = q·p / 10^6`, computed in u128. Buyers pay `ceil`, sellers receive `floor`. All rounding dust accrues to the maker bucket, so quote is conserved exactly (§7.5).
- **Basis points:** 1e4 = 100%. A fee is `ceil(amount · bps / 1e4)`. A share is `floor(amount · bps / 1e4)`, and the remainder goes to the other party.
- **Time:** slots for batch windows and sealing; unix seconds for hold decay.

---

## 3. Accounts

All accounts are PDAs of this program unless noted. Every struct has `version: u8, bump: u8` first and `#[derive(InitSpace)]`.

### `BoardConfig`: seeds `["board"]`, a singleton

| Field | Type | Meaning |
|---|---|---|
| `auction_authority` | Pubkey | Sets the launch fee and line parameters. This key is held by the auction network (stage manager) service |
| `board_authority` | Pubkey | Calls `set_stage`, on behalf of the off-chain timer and cut rules |
| `treasury` | Pubkey | Platform wallet that platform fees and swept reserves are paid to |
| `launch_fee` | u64 | In quote atoms of `launch_quote_mint` |
| `launch_quote_mint` | Pubkey | Quote mint new markets must use (one quote asset per deployment) |
| `launch_fee_maker_share_bps` | u16 | Share of the launch fee seeded into the new coin's `maker_quote` |
| `line_open` | bool | Whether new launches are accepted |
| `markets_created` | u64 | Counter, for indexing |

Instructions:
- `initialize_board` is signed by the program upgrade authority. Copy the pattern from `initialize_config`, which also gates on the upgrade authority.
- `update_board` is signed by `config.admin` for authorities and the treasury, and by `auction_authority` for `launch_fee`, `launch_fee_maker_share_bps` and `line_open`.

### `Market`: seeds `["market", base_mint]`

| Group | Fields |
|---|---|
| Identity | `base_mint`, `quote_mint`, `base_vault`, `quote_vault` (token accounts owned by the market PDA), `deployer` (participant PDA), `quoter` (Pubkey, signs commits), `created_at`, `created_slot` |
| Supply | `total_supply` (u64, base atoms, immutable) |
| Stage | `stage: Stage` (`Line, Rookie, Regular, Cut, Dead`), `stage_changed_at` |
| Batch clock | `batch_id` (next batch to commit), `last_settled_batch`, `last_price`, `batch_len_slots` (u32), `open_price` |
| Quoter buckets (quote atoms) | `maker_quote: i64` (may go negative, down to `-risk_allowance`), `maker_fee_income: u64` (reporting only), `maker_trading_quote: i64` (reporting only: Σ quote delta from fills) |
| Quoter inventory | `maker_base: u64` |
| House | `risk_allowance: u64` (house money behind this coin, default 0), `risk_drawn_peak: u64` (reporting) |
| Fees | `platform_fees: u64` (owed to the treasury, not yet paid out), `deployer_fees: u64` (claimable), `deployer_fee_bps: u16`, `platform_fee_share_bps: u16` (of the non-deployer fee) |
| Liabilities | `total_user_quote: u64`, `total_user_base: u64` (Σ over Positions; used for the vault invariant) |
| Bounds (hyperparameters, fixed at creation, admin-updatable) | `bounds: TermsBounds` |
| Exposure limits | `limits: MakerLimits` |
| Dead coin | `final_reserve_quote: u64`, `swept: bool` |

```rust
pub struct TermsBounds {           // per market; rookie vs regular set by stage
    pub max_total_fee_bps: u16,    // cap on base+speed+hold+large_holder at any point
    pub max_hold_secs: u32,
    pub min_cap_bps: u16, pub max_cap_bps: u16,       // e.g. 50..=200 (2% stand-in)
    pub rookie_max_cap_bps: u16,                       // stricter for rookies
    pub max_per_person_batch_max: u64,
}
pub struct MakerLimits {
    pub max_net_sell_per_batch: u64,  // release-rate cap on unissued supply (base atoms)
    pub max_net_buy_per_batch: u64,
    pub max_price_move_bps: u16,      // |clearing - last_price| bound per batch; rookie uses rookie_max_price_move_bps
    pub rookie_max_price_move_bps: u16, // "rookies trade wilder"
}
```

The price-move bound is a safety rail on the relayer: it stops a buggy clearing from settling at an absurd price. Set it wide (for example 5000 bps for rookies) so it never binds in normal trading **(spec choice)**.

### `Position`: seeds `["position", market, participant]`

`market`, `participant`, `base: u64`, `quote: u64`, `last_buy_ts: i64`, `batch_seen: u64`, `batch_bought: u64`, `batch_sold: u64` (per-batch size tracking across chunks), `total_bought`, `total_sold`, `fees_paid` (reporting).

### `Batch`: seeds `["batch", market, batch_id_le]`

| Field | Meaning |
|---|---|
| `market`, `batch_id` | |
| `status: BatchStatus` | `Committed → Settling → Settled` |
| `quote_hash: [u8;32]` | Hash of the hidden maker reveal (§5) |
| `terms: TermsSchedule` | **Public** schedule, visible from commit onward (§6) |
| `commit_slot`, `cutoff_slot` | Intents count only if `commit_slot < created_slot ≤ cutoff_slot`. Settlement begins only at a slot `> cutoff_slot` |
| `clearing_price` | Set at `begin_settlement` |
| `maker_buy: Option<CurveFixed>`, `maker_sell: Option<CurveFixed>` | Revealed and decoded at begin. `CurveFixed` = `{ n: u8, points: [CurvePoint; 16] }`, so the size is fixed |
| `declared_user_buy`, `declared_user_sell` | Totals the relayer declares at begin |
| `acc_user_buy`, `acc_user_sell`, `acc_buyer_paid`, `acc_seller_recv`, `acc_fees`, `intents_settled` | Running sums across chunks |
| `maker_net: i64` | Set at finalize |

### `Intent` change
Add `created_slot: u64`, set in `submit_intent` from `Clock::slot`. Everything else is unchanged.

---

## 4. Instructions

Every handler emits an event (§9). Every arithmetic step uses `checked_*` / `accounting.rs` helpers.

### 4.1 `create_market(args)`

- **Signer:** a deployer wallet with **Admission** eligibility (reuse `SasBadge` + `require_eligible`), payer.
- **Requires** `board.line_open`, and `quote_mint == board.launch_quote_mint`.
- **Args:** `name`, `symbol`, `uri`, `total_supply`, `open_price`, `batch_len_slots`, `bounds`, `limits`, `deployer_fee_bps (≤ 500)`, `platform_fee_share_bps`, `quoter: Pubkey`.
  - `bounds`, `limits` and the fee shares must lie inside hard program constants: `MAX_FEE_BPS_HARD = 2000`, `MAX_CAP_BPS_HARD = 1000`, `MIN_BATCH_SLOTS = 2`.
  - `quoter` must equal `config.settlement_authority`'s registered quoter, or simply be stored as given **(spec choice: stored as given; the admin can replace it via `update_market`)**.
- **Accounts:** board (mut), config, deployer wallet + participant + binding + badge, a new base mint (signer keypair or PDA `["mint", market]`; **spec choice: PDA `["mint", deployer_participant, markets_created_le]`** so it's deterministic), market (init), base_vault and quote_vault (init, token accounts with authority = market PDA, at PDAs `["vault", market, mint]`), deployer's quote token account (pays the launch fee), treasury quote token account, token programs, system program.
- **Effects:**
  1. Init the base mint (Token-2022 + metadata) with mint authority = market PDA, and mint `total_supply` into `base_vault`.
  2. **Set mint authority to None.** Freeze authority None.
  3. Market starts with `maker_base = total_supply`, `stage = Line`, `batch_id = 0`, `last_price = open_price`.
  4. Launch fee: transfer `board.launch_fee` from the deployer to the market `quote_vault`. Credit `fee · maker_share_bps / 1e4` to `maker_quote`, and the rest to `platform_fees`. This leaves the tokens in the vault, and the treasury collects them later.
  5. `board.markets_created += 1`.

### 4.2 Funds

- `deposit_quote(amount)` / `deposit_base(amount)`
  - Requires **Admission** eligibility: current wallet, SAS badge.
  - Uses `init_if_needed` for `Position`.
  - Transfers with `transfer_checked` from the wallet's token account to the vault.
  - Credits the position and `total_user_*`.
  - `deposit_base` lets a user bring back coins they previously withdrew to their wallet.
- `withdraw_quote(amount)` / `withdraw_base(amount)`
  - **Ownership only.** The signer must be `participant.current_wallet`. There is no eligibility, pause or stage check, so users can always exit.
  - Debits the position and totals.
  - `transfer_checked` from the vault to the wallet's token account, signed by the market PDA.
  - Blocked only while `Batch.status == Settling` for this market. The demo relayer finishes a settlement within a few transactions; this prevents reading half-settled state. Add `Market.settling: bool` for this.

### 4.3 House and admin

- `fund_risk_allowance(amount)`
  - Signer: `config.admin`.
  - Transfers quote into the vault, and `risk_allowance += amount`.
- `withdraw_risk_allowance(amount)`
  - Allowed only while `maker_quote ≥ 0` and the remaining allowance stays ≥ what is drawn. That means `maker_quote + risk_allowance - amount ≥ 0` and `risk_allowance ≥ amount`.
- `collect_platform_fees()`
  - Permissionless. Pays `platform_fees` to `board.treasury`'s token account and zeros the counter.
- `claim_deployer_fees()`
  - Signer: the deployer participant's current wallet. Pays `deployer_fees`.
- `update_market(args)`
  - Signer: `config.admin`.
  - Can change `quoter`, `bounds`, `limits` and `batch_len_slots`, always within the hard constants.
  - Not allowed while settling.
- `set_stage(stage)`
  - Signer: `board.board_authority`.
  - Allowed transitions: `Line→Rookie`, `Rookie→Regular`, `Line→Cut`, `Rookie|Regular→Dead`, `Rookie→Cut` **(open, implemented as allowed)**. Nothing ever moves backwards.
  - On `Cut`/`Dead`: set `final_reserve_quote = max(maker_quote, 0)`. Trading instructions then fail with `MarketClosed`; withdrawals keep working.
- `sweep_dead_reserve()`
  - Signer: `config.admin`. Requires stage `Cut|Dead`, and `!swept`.
  - Moves `maker_quote` (if > 0) into `platform_fees`, then `swept = true`.
  - Mark it in a code comment as the placeholder for the open "money left by a dead coin" decision.
  - Holders keep their base tokens and their quote balances. Holders of a cut line coin keep their now-untradeable coins; this is the "lose their stake" rule from the decision log.

### 4.4 `commit_batch(batch_id, quote_hash, terms)`

- **Signer:** `market.quoter`, payer.
- **Requires:**
  - `batch_id == market.batch_id`
  - stage ∈ {Line, Rookie, Regular}
  - `!market.settling`
  - the previous batch is settled, or this is batch 0. Equivalently, `batch_id == last_settled_batch + 1` (with batch 0 handled specially).
- Validates `terms` within `market.bounds` (§6). Uses `rookie_max_cap_bps` when the stage is Line or Rookie.
- Inits `Batch`:
  - `commit_slot = now_slot`, `cutoff_slot = now_slot + batch_len_slots`
  - `status = Committed`
  - `market.batch_id += 1`, so the next commit targets the following batch.

The commit is firm: no instruction modifies `quote_hash` or `terms` after init. A second commit for the same id fails on `init`.

### 4.5 Settlement: `begin_settlement` → `settle_chunk`×k → `finalize_settlement`

For a small batch, all three go in **one transaction**, so settlement is atomic. For a large batch they are spread over several transactions. One code path handles both.

#### `begin_settlement(batch_id, clearing_price, maker_reveal, declared_user_buy, declared_user_sell)`

- **Signer:** `config.settlement_authority`.
- **Requires:**
  - `Batch.status == Committed`, and `now_slot > cutoff_slot`
  - `!market.settling`
  - stage tradeable
- **Checks:**
  1. `quote_hash(market, batch_id, maker_reveal) == Batch.quote_hash`. Decode both maker curves into the `Batch`. The reveal has a buy curve with side Buy and a sell curve with side Sell, each optional.
  2. `clearing_price > 0`, and `|clearing_price − last_price| ≤ last_price · max_move_bps / 1e4`. Use the rookie bound for Line and Rookie. Skip this check for the first settled batch.
  3. Maker feasibility for the declared totals, with `net = declared_user_buy − declared_user_sell`:
     - If `net > 0`: `qty_at(maker_sell, p) ≥ net`, `net ≤ maker_base`, and `net ≤ limits.max_net_sell_per_batch`.
     - If `net < 0`: `qty_at(maker_buy, p) ≥ |net|`, `|net| ≤ limits.max_net_buy_per_batch`, and `maker_quote + risk_allowance ≥ ceil(notional(|net|, p))`. This is the worst case the maker pays, since dust only helps the maker.
     - If `net == 0`: nothing to check.
- **Effects:** `status = Settling`, `market.settling = true`, store `clearing_price` and the declared totals.

#### `settle_chunk(batch_id, items: Vec<ChunkItem { contents: Vec<u8>, fill: u64 }>)`

- **Signer:** `settlement_authority`.
- **Requires:** `status == Settling`, and `1 ≤ items.len() ≤ MAX_CHUNK_INTENTS (= 6)`.
- **Remaining accounts:** 7 per item, `[intent(mut), participant, wallet_binding, attestation, badge_mint, badge_token_account, position(mut)]`. Shared SAS accounts come in `SasBadgeShared`.
- **Per item:**
  1. Run the existing per-intent validation from `validate_batch` (refactor it into `validate_intent(...) -> ValidatedIntent`), including SAS **Standing** eligibility.
  2. Check `commit_slot < intent.created_slot ≤ cutoff_slot`.
  3. The `Position` PDA must equal `["position", market, participant]`. **Reject a duplicate participant within the chunk.** Across chunks it is safe, because each transaction reads fresh state.
  4. Decode `TradeContents`, and require `fill ≤ qty_at(curve, p)` (§8).
  5. Per-person batch size: if `position.batch_seen != batch_id`, reset `batch_bought` and `batch_sold` to 0 and set `batch_seen`. Then require `batch_bought + batch_sold + fill ≤ terms.per_person_batch_max`.
  6. Apply the fill with the fees from §6:
     - **Buy:** debit `quote` by `ceil(notional) + fee`, credit `base` by `fill`. If `fill > 0`, set `last_buy_ts = now`. Then require `base ≤ total_supply · cap_bps / 1e4`.
     - **Sell:** require `floor(notional) ≥ fee`. Debit `base`, credit `quote` by `floor(notional) − fee`.
  7. Update the totals (`total_user_quote`, `total_user_base`), the batch accumulators, and the reporting counters.
  8. Mark the intent `Consumed`, even if `fill == 0`. A batch order is immediate-or-cancel.
- **Accumulators:** after the chunk, require `acc_user_buy ≤ declared_user_buy` and `acc_user_sell ≤ declared_user_sell`.
- **Event:** emit `ChunkSettled` with per-fill records, including the **revealed contents**, for the public verifier.

#### `finalize_settlement(batch_id)`

- **Signer:** `settlement_authority`.
- **Requires:** `acc_user_buy == declared_user_buy` and `acc_user_sell == declared_user_sell`.
- **Maker leg,** with `net = acc_user_buy − acc_user_sell`:
  - `maker_base -= net` when net > 0, `maker_base += |net|` when net < 0.
  - `trading_delta = acc_buyer_paid − acc_seller_recv` (i128 → i64). Add it to both `maker_quote` and `maker_trading_quote`.
- **Fees,** from `acc_fees`:
  - `deployer = floor(fees · deployer_fee_bps / 1e4)` if stage ∈ {Rookie, Regular}, else 0.
  - `platform = floor((fees − deployer) · platform_fee_share_bps / 1e4)`.
  - `maker = fees − deployer − platform`.
  - Add each to its counter; the maker share also goes into `maker_fee_income`.
- **Funding:** require `maker_quote ≥ −(risk_allowance as i64)`. Update `risk_drawn_peak`.
- **Vault invariants** (§7.6) must hold.
- **Effects:**
  - `status = Settled`, `market.settling = false`, `last_price = p`, `last_settled_batch = batch_id`
  - emit `BatchSettled`.

#### Empty batch
`begin_settlement` with declared 0/0, followed immediately by `finalize_settlement`, works unchanged. The relayer sends both in one transaction.

#### Stuck batch
`abort_settlement(batch_id)` is allowed only if `intents_settled == 0`. Signer: `settlement_authority`. It returns the batch to `Committed`, so the relayer can re-begin it with corrected declared totals. A batch that has applied fills cannot be aborted, only finished. This is safe because the relayer computes the fills before beginning, and the verifier would flag a bad finish.

---

## 5. Maker reveal and hash

```
maker_reveal = u8 version(=1)
            || u8 has_buy  || [TradeContents bytes, side=Buy]   if has_buy
            || u8 has_sell || [TradeContents bytes, side=Sell]  if has_sell
            (exact length, no trailing bytes; at least one side present)

quote_hash = sha256( u32le(len(D)) || D
                   || market (32) || u64le batch_id
                   || terms_bytes            // §6 canonical encoding, binds public terms too
                   || u32le(len(maker_reveal)) || maker_reveal )
D = b"learned-markets:quote:v1"
```

- Add `TradeContents::decode_prefix(&[u8]) -> Result<(Self, usize)>`. The length is self-describing: `3 + 16n`.
- The maker curve stays secret until `begin_settlement`. Terms are public from the commit.
- Optional, deferred beyond v0 by the log: traders verifying the commitment themselves.

---

## 6. Public terms schedule (the learned-terms interface)

The quoter outputs a `TermsSchedule` each batch. The program evaluates it **per person** from that person's `Position` at fill time. This is how the decision "terms may depend on anything about a person; first implementation uses their position and how recently they bought" is realized.

```rust
pub struct TermsSchedule {          // canonical bytes = fields in order, little-endian
    pub version: u8,                // 1
    pub base_fee_bps: u16,          // every fill, both sides
    pub speed_fee_bps: u16,         // sells: × (fill / base_before_this_fill), i.e. selling your whole bag in one batch pays the full amount
    pub hold_fee_bps: u16,          // sells: linear decay from hold_fee_bps at last_buy_ts to 0 at +hold_secs
    pub hold_secs: u32,
    pub large_holder_share_bps: u16,// buys: if post-fill share of supply > this…
    pub large_holder_fee_bps: u16,  // …charge this extra
    pub cap_bps: u16,               // max share of total_supply one person may hold
    pub per_person_batch_max: u64,  // base atoms per person per batch (buys + sells)
}
```

### Fee for one fill

Let `n` be the notional (ceil for buys, floor for sells), and let `share_after = (base_after · 1e4) / total_supply`.

- **Buy:** `bps = base_fee_bps + (share_after > large_holder_share_bps ? large_holder_fee_bps : 0)`.
- **Sell:**
  - `elapsed = now − last_buy_ts`
  - `hold = elapsed ≥ hold_secs ? 0 : hold_fee_bps · (hold_secs − elapsed) / hold_secs` (floor)
  - `speed = base_before == 0 ? 0 : speed_fee_bps · fill / base_before` (floor)
  - `bps = base_fee_bps + speed + hold`
- `bps = min(bps, bounds.max_total_fee_bps)`, then `fee = ceil(n · bps / 1e4)`.

### Validation at commit

- `base + speed + hold + large ≤ max_total_fee_bps`
- `hold_secs ≤ max_hold_secs`
- `cap_bps ∈ [min_cap_bps, stage_max_cap]`, where `stage_max_cap = rookie_max_cap_bps` for Line and Rookie, `max_cap_bps` otherwise
- `per_person_batch_max ≤ max_per_person_batch_max`
- `large_holder_share_bps ≤ cap_bps`

**Fixed stand-in** (the submission fallback in the log): the quoter service sends a constant schedule every batch. The program doesn't care whether a schedule is learned or fixed.

Limit prices are **gross**: the curve price is compared to the clearing price, and fees are charged on top **(open: "whether limit prices include fees", implemented as gross)**.

---

## 7. Invariants (state them in code comments; test each one)

1. **Curve respect.** No user fill exceeds that user's curve quantity at `p`. The maker's net fill does not exceed its revealed curve at `p`.
2. **Base conservation.** `Σ user buy = Σ user sell + maker net sell`, enforced by `declared == accumulated` and by the maker leg being derived from them.
3. **Funded.** No position, `maker_base`, or `maker_quote + risk_allowance` goes negative.
4. **Caps.** After every buy, a holder's position is ≤ `cap_bps` of supply. Each person's batch total is ≤ `per_person_batch_max`. The maker's net per batch stays within `limits`. The price move stays within its bound.
5. **Quote conservation, exact.** `Σ buyer debits = Σ seller credits + Σ fees + trading_delta`. The fee split sums back to `acc_fees`.
6. **Vault backing.** Check after every state-changing instruction that moves balances, using `reconcile_backing` plus `inspect_token` on the vaults:
   - `quote_vault.amount ≥ total_user_quote + platform_fees + deployer_fees + max(maker_quote,0) + (risk_allowance − max(−maker_quote,0))`
   - simplified: `quote_vault.amount == total_user_quote + platform_fees + deployer_fees + maker_quote + risk_allowance`, in i128
   - `base_vault.amount == total_user_base + maker_base`, which also means `== total_supply` while all coins stay in the vault
   - Coins withdrawn to wallets leave both sides of that equation, so it becomes `base_vault.amount == total_user_base + maker_base`, and `total_supply` is still fixed by the revoked mint authority.
7. **Sealing.** Every settled intent was created strictly after the commit and no later than the cutoff. The maker reveal matches the commit hash.
8. **Exit always works.** Withdrawals need only wallet ownership, outside an in-flight settlement.

**Not on-chain:** whether `p` maximizes volume, whether it is nearest `last_price`, and whether rationing on the long side was pro rata with better prices first. The verifier in §11 checks all of these from the events.

---

## 8. `qty_at(curve, p)`: must match Python and TS exactly

Points have strictly increasing prices.

- **Buy** (quantity non-increasing):
  - `p < p₀` → `q₀`
  - `p > p_last` → `0`
  - `p` equal to a point's price → that point's `q`
  - otherwise interpolate between the neighbours
- **Sell** (quantity non-decreasing):
  - `p < p₀` → `0`
  - `p > p_last` → `q_last`
  - `p` equal to a point's price → that point's `q`
  - otherwise interpolate
- **Interpolation,** always rounding toward the smaller quantity, in i128:
  - increasing segment: `qa + (qb−qa)·(p−pa) / (pb−pa)` (floor)
  - decreasing segment: `qa − ceil((qa−qb)·(p−pa) / (pb−pa))`

Put the function in `payload.rs`, with unit tests.

---

## 9. Events

`BoardInitialized`, `BoardUpdated`, `MarketCreated{market, base_mint, quote_mint, deployer, total_supply, open_price, launch_fee, bounds, limits}`, `StageChanged`, `Deposited{market, participant, asset, amount}`, `Withdrawn`, `RiskAllowanceChanged`, `FeesCollected`, `DeployerFeesClaimed`, `ReserveSwept`, `BatchCommitted{market, batch_id, quote_hash, terms, commit_slot, cutoff_slot}`, `SettlementBegun{market, batch_id, clearing_price, maker_reveal, declared_user_buy, declared_user_sell}`, `ChunkSettled{market, batch_id, fills: Vec<FillRecord>}`, `BatchSettled{market, batch_id, clearing_price, user_buy, user_sell, maker_net, trading_delta, fees, fee_split{platform, maker, deployer}, maker_base, maker_quote}`.

- `FillRecord = { intent, participant, side, contents (revealed curve bytes), fill, notional, fee, base_after, quote_after }`.
- Anchor's `emit!` uses `sol_log_data`, which is limited by log size. If `ChunkSettled` with 6 records nears the limit, emit one `FillSettled` per item instead.
- The quoter's observations and the verifier are built **only** from these events and account state.

---

## 10. Errors (append to `GateError`)

`BoardNotInitialized, LineClosed, QuoteMintNotAllowed, BoundsOutOfRange, LimitsOutOfRange, MarketClosed, MarketSettling, WrongBatchId, PreviousBatchUnsettled, BatchNotCommitted, BatchNotSettling, BatchWindowOpen, IntentOutsideBatchWindow, QuoteHashMismatch, MalformedReveal, TermsOutOfBounds, PriceMoveTooLarge, MakerCurveExceeded, MakerInventoryExceeded, MakerBudgetExceeded, MakerLimitExceeded, FillExceedsCurve, PerPersonBatchMaxExceeded, HoldCapExceeded, FeeExceedsProceeds, DuplicateParticipantInChunk, DeclaredTotalsExceeded, DeclaredTotalsMismatch, CannotAbortStartedBatch, VaultInvariantViolated, InvalidStageTransition, NotQuoter, NotBoardAuthority, NotAuctionAuthority, AlreadySwept, NothingToClaim`.

Remove the v1 `settle_batch` instruction, but keep the `SettlementNotImplemented` variant so the error codes stay stable.

---

## 11. Off-chain integration (same branch; separate agent if parallelizing)

### 11.1 Shared vectors: `fixtures/settlement-vectors.json`
The Rust tests write the vectors; TS and Python read them and must match. Cover:
- the `qty_at` cases, including both curve ends, exact points and decreasing segments
- the `TermsSchedule` encoding
- a maker reveal and its `quote_hash`
- the fee evaluations: a buy with the large-holder fee, and sells with partial hold decay and speed
- one worked two-chunk batch: inputs → every position and market counter after

### 11.2 TS client: `packages/client`
Follow its `AGENTS.md`: Codama generation from `target/idl/learned_markets.json` into `src/generated/`. Hand-written helpers go in `src/`:
- PDA derivations
- `encodeTerms`, `encodeReveal`, `quoteHash`, `qtyAt`, `feeFor`, all tested against the vectors
- `buildSettlementTxs(batch, fills)`
  - Packs `begin + chunks + finalize` into as few v0 transactions as fit.
  - Creates and extends one **address lookup table** per market holding the static accounts: config, board, market, vaults, SAS shared accounts and token programs.
  - Per-intent accounts go in the lookup table too when the relayer has seen them in earlier batches.
  - Adds a compute-budget instruction requesting 1.4M CU.

### 11.3 Relayer: `apps/settler` (TS, Node ≥ 22, npm workspace)

The loop, per market:
1. Read the market and the latest `Batch`.
2. If no batch is open, ask the quoter: `POST {QUOTER_URL}/quote` with the observation (below). The response is `{ terms, maker_reveal_hex }`. Send `commit_batch(batch_id, quoteHash(...), terms)`.
3. Collect intents for the batch:
   - **On-chain:** `IntentSubmitted` logs through `logsSubscribe`, or a QuickNode Stream webhook (§11.6).
   - **Off-chain:** the curve contents. Users `POST /orders {intent, contents_hex}` to the relayer, which checks `payload_hash`. Contents stay private until settlement, which is the sealed property.
4. After `cutoff_slot`, call `POST {QUOTER_URL}/clear { user_curves, maker_reveal, last_price }`, which returns `{ clearing_price, fills[] }`. Check the result locally with the same invariants as the program, then send the settlement transactions.
5. Intents created outside the window roll over to the next batch automatically. Intents past their deadline are dropped.

Config comes from environment variables: `LM_RPC_URL`, `LM_NETWORK`, `LM_SETTLEMENT_KEY`, `LM_QUOTER_KEY`, `QUOTER_URL`, `MARKETS`.

The **observation** sent to `/quote` contains only:
- public state: market account, stage, last N `BatchSettled` events
- the quoter's own buckets: `maker_base`, `maker_quote`, `risk_allowance`
- the slot and time

Never open intents. This keeps the batch sealed with respect to the quoter, and the same struct feeds the RL environment.

### 11.4 Quoter service contract (Python, `apps/backend`; owned by the RL side)
- `POST /quote(obs) → { terms: TermsSchedule, maker_reveal_hex }`. The rule-based stand-in sits behind the same endpoint as the PPO checkpoint.
- `POST /clear({user_curves, maker_reveal, last_price}) → { clearing_price, fills[] }`.
  - The price is volume-maximizing and nearest `last_price` on ties.
  - Fills must satisfy §7.1–7.4, including the per-person caps and the maker's curve at `p`.
  - Rationing on the long side is pro rata, best prices first, with users and the quoter at equal priority.
- Both must use the same `qty_at`, units and fee math as the vectors.

### 11.5 Public verifier: `scripts/verify-batches.ts`
For a market, fetch every `BatchCommitted`, `SettlementBegun`, `ChunkSettled`/`FillSettled` and `BatchSettled` event, then:
- recompute `quote_hash`
- rebuild aggregate demand and supply from the revealed user and maker curves
- check that `p` maximizes volume and is nearest `last_price`
- check that rationing was pro rata at `p`
- recompute every fee and balance delta

Exit code 0 means every batch passed. Its output is the "anyone can verify" artifact for the README and demo.

### 11.6 QuickNode Streams (sponsor bounty)
Create a Stream on devnet filtered to this program ID's transactions, with a webhook destination at the relayer's `/stream` endpoint. It feeds `IntentSubmitted` and `BatchSettled` into the relayer and the web UI. Document the network, dataset, filter, destination and why the build depends on it in the README, as `docs/HACKATHON.md` requires.

### 11.7 Demo bots: `scripts/bots.ts`
3–6 attested demo participants (reuse `scripts/two-user-client-demo.ts` for registration) submitting curve intents:
- background traders
- one informed trader
- one "dump right after buying" trader, to show the hold and speed fees
- one would-be hoarder, to show the cap

---

## 12. Tests (LiteSVM, `tests/program-tests/tests/market.rs` + `settlement.rs`)

Extend `src/lib.rs` with builders for every new instruction plus the token helpers: create the quote mint, mint to a user, read a token balance. Then cover the following.

**Setup**
1. Initialize the board, then create a market. Assert the mint authority is None, the supply is in `base_vault`, `maker_base == total_supply`, and the launch fee is split.

**Funds**

2. Deposit and withdraw both assets. Withdraw still works after `suspend_participant` and after `Cut`.

**Commit and sealing**

3. Bad terms are rejected (each bound). A second commit for the same batch is rejected. A commit before the previous batch settles is rejected.
4. Sealing: an intent created before `commit_slot` or after `cutoff_slot` is rejected. Settling before the cutoff is rejected. A reveal that doesn't match the hash is rejected.

**Settlement**

5. Happy path, one transaction (begin + one chunk + finalize):
   - Two buyers against the maker's sell curve. This is the "quoter is the launch" path.
   - Assert every counter and both vault invariants.
6. Happy path, two transactions: two chunks, then finalize. Sellers inside the hold window pay the decayed hold fee and the speed fee; check exact amounts against the vectors.
7. Each rejection:
   - fill > curve
   - maker curve exceeded
   - maker inventory exceeded
   - maker budget exceeded, then allowed after `fund_risk_allowance`
   - maker per-batch limit exceeded
   - price move too large
   - hold cap exceeded (rookie cap stricter than regular)
   - per-person batch max exceeded across two chunks
   - fee greater than proceeds
   - duplicate participant in a chunk
   - declared totals exceeded or mismatched at finalize
   - a withdraw during settlement
8. An empty batch advances. `abort_settlement` works before any chunk and fails after one.

**Fees and stages**

9. Fees: the deployer accrues nothing during Line and accrues after `set_stage(Rookie)`. `claim_deployer_fees` and `collect_platform_fees` pay out the exact counters.
10. Stages: invalid transitions are rejected. After `Dead`, trading instructions are rejected, then `sweep_dead_reserve` runs once and fails a second time.

**Maintenance**

11. Update `smoke.rs`/`gate.rs`/`fixtures.rs` for the removed v1 settle and the new `Intent.created_slot`. Regenerate `fixtures/onchain-accounts.json` and `fixtures/intent-payload-vectors.json` if the fixture test writes them.

---

## 13. Milestones and parallelization

Each milestone ends with `anchor build`, all tests green, and a commit.

| # | Scope | Leaves the program |
|---|---|---|
| M1 | Board, Market, `create_market` with real mint + revoke + launch fee, Position, deposit/withdraw both assets, `set_stage` | Yes: launch + custody demo |
| M2 | `TermsSchedule`, `commit_batch`, `Intent.created_slot`, sealing window, reveal/hash, `qty_at`, `begin`/`settle_chunk`/`finalize` with all §7 invariants, vectors file | Yes: full trading |
| M3 | Risk allowance, fee split + deployer accrual and claim, collect fees, abort, sweep, `update_market`, the full §12 test list | Yes |
| M4 | Deploy: surfpool on chungus, then a devnet upgrade at the same ID | Needed for the submission |
| M5 | `packages/client` (Codama + helpers), `apps/settler`, `scripts/verify-batches.ts`, bots, QuickNode Stream | End-to-end |

**Parallel plan:**
- Agent A does M1 → M2 → M3 → M4.
- Agent B starts M5 against this spec as soon as M2's IDL exists. Before then it can write helpers and vector tests from §5, §6 and §8.
- The RL side implements §11.4 against `fixtures/settlement-vectors.json`.

**Deploy notes:**
- Surfpool: `solana program deploy --use-rpc` (no TPU). Run the tunnel `ssh -f -N -L 8899:127.0.0.1:8899 -L 8900:127.0.0.1:8900 soham@chungus` from the Mac. State is in memory, so a surfpool restart means re-running setup.
- Devnet: the `.so` grows, so run `solana program extend nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz <extra_bytes>` before upgrading. The public RPC drops buffer writes; resume with `scripts/resume-buffer-write.ts <buffer> <so>`, then `solana program deploy --buffer`.
- `initialize_board` must be signed by the upgrade authority (`keys/deployer.json`).
- Record the rollout in `docs/rollout/devnet-market.json`.

## 14. Done checklist

- [ ] M1–M3 merged on `settlement-v2`. `anchor build` is clean, and both test suites pass.
- [ ] `fixtures/settlement-vectors.json` exists, and TS and Python helpers pass against it.
- [ ] Surfpool: the relayer runs ≥ 20 batches with bots, and `verify-batches.ts` exits 0.
- [ ] Devnet: the same run, with program ID, market, mint and vault addresses recorded for the README.
- [ ] `docs/ai-gen/onchain-validation.md` describes the accounts, instructions and invariants. The README lists the program ID, the economic design, the risk assumptions (relayer trust: it can withhold orders but cannot misprice or misfill without the verifier catching it), and the QuickNode configuration.
