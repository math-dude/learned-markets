# On-chain validation foundation

## Authorization

The existing [attestation gate](attestations.md) is the authorization layer. The program upgrade authority initializes the canonical config PDA and pins the SAS trust anchors. The configured admin can rotate the admin or settlement authority, control the admission pause, and manage participant status and wallet replacement under the existing registry rules.

`gate::require_eligible` checks canonical registry accounts, active participant status, the current wallet binding, and the SAS attestation and badge. Admission checks honor both the config and SAS schema pauses. Standing checks continue to validate eligibility during pauses.

## Read-only Rust APIs

| API | Inputs and guarantees |
|---|---|
| `references::read_account::<T>` | Supply an expected address from trusted state or canonical derivation. The helper checks the address, the owner declared by `T`, the non-executable flag, and the discriminator before decoding the expected Anchor Borsh layout. Coin recognition requires an application-specific relationship to the validated account. |
| `assets::inspect_sol` | Supply an account to read its address, owner, executable flag, and lamports without a signature. The caller establishes the expected address and ownership when those properties matter. |
| `assets::inspect_token` | Supply the mint and token accounts plus a trusted token program, mint address, and token-account authority. Both accounts must be initialized, non-executable, and owned by the expected classic SPL Token or Token-2022 program. The account's mint and owner fields must match. The snapshot reports raw base units, decimals and frozen status. Bind the token-account address separately when an instruction requires a specific account, such as a canonical ATA. |

Token-2022 snapshots also return the extension identifiers on the mint and the token account. Inspection uses the pinned SPL interfaces for decoding and rejects unknown extension types, duplicate entries, invalid account kinds, and malformed extension lengths. Transfer eligibility, delegated authority, and net proceeds require separate validation.

## Accounting

Use integer base units of one asset per calculation. The caller supplies a trusted protected amount and liabilities in the same units as the observed balance.

- `checked_credit` adds an amount and fails on overflow.
- `checked_debit` subtracts an amount and fails on insufficient balance.
- `available_balance` subtracts the protected amount and fails when protection exceeds the balance.
- `has_sufficient_balance` applies the same protection check and returns whether the available amount covers the request, including equality.
- `reconcile_backing` subtracts the supplied liabilities from observed backing and returns the surplus or a deficit error.

These functions compute values in memory. Ownership, reservations, and custody remain decisions for future instructions.

## Events and compatibility

`ConfigInitialized` and `ConfigUpdated` report the config PDA and the resulting admin, settlement authority, and admission pause flag. `ConfigUpdated` also identifies the signer who authorized the update, which matters when the update rotates the admin. Both events are emitted after the handler's validation succeeds. Consumers should rely on events from successful transactions.

The IDL adds these two events and their types and appends validation errors. The helpers are Rust APIs for future handlers.


## Atomic parity ledger

The current backend/program contract follows
[the environment settlement interface](design/settlement-interface.md).
`programs/learned-markets/src/ledger.rs` defines separate accounts for simulated
cash and whole-token positions.

| Account | Seeds | Role |
| --- | --- | --- |
| LedgerMarket | ledger-market, market_id | Coin reserve cash/tokens, latest batch and price, live flag |
| LedgerBalance | ledger-balance, participant | Cash shared across coins |
| LedgerPosition | ledger-position, market, participant | One person's whole-token position |
| LedgerPlatform | ledger-platform | Platform fees |

`open_ledger_market` debits the deployer's recorded launch fee and splits it
between reserve and platform. `initialize_ledger_position` creates the canonical
position. `settle_ledger_batch` uses the existing eligibility and intent
validation, then verifies step-curve quantity, positive fills, one participant
per batch, seller fee bounds, funding and token conservation. It derives reserve
cash from rounded user notionals and splits fees once per atomic batch. Batch
IDs increase strictly. A failure rolls back every fill and leaves intents open.
`close_ledger_market` stops trading and retains the reserve record.

The program bounds the auctioneer's ppm sell fee between the 1% base and 25%
ceiling. The Python core owns position-dependent exit-term evaluation and
clearing optimality. These remain settlement-authority trust assumptions.
Cash arithmetic uses checked integers and u128 products. Prices are
micro-lamports per whole token.

`credit_ledger_balance` requires an explicit `demo-credit` build, admin signature
and a development-network configuration label. The label is operator-supplied.
Deployment controls establish the target cluster. Ledger accounts own recorded
units and remain separate from the M1 token vaults.

The Python Codama client reproduces actual SBF instruction bytes and account
data from `fixtures/ledger-wire.json`. LiteSVM replays the six-batch
`fixtures/settlement-episode.json` produced by the shared Python core and compares
all balances after each batch. The current parity program has local test
evidence. Deployment and live backend submission remain pending.
