# Participant attestations, on-chain gating, and settlement scaffold

Devnet participation system: a tokenized SAS attestation (**Learned Markets Demo Pass**, `LMTEST`) binds an operator-approved test participant to one wallet. An on-chain registry enforces that binding, and only bound wallets can register `Trade` and `Nomination` intents, including through direct program calls and CPI.

**What it protects.** Unapproved wallets can't register eligible intents. Replacing a wallet keeps the participant's identity and nonce sequence, and never leaves two active bindings.

**What it doesn't protect.** An approved participant can still automate their own wallet. Gating doesn't show that a trade was entered by hand. Sealed batches, allocation rules and maker risk controls are separate protections. Registering an intent doesn't reserve funds, guarantee a fill, or prove the participant has enough balance. Settlement is a scaffold that always returns `SettlementNotImplemented`.

## Layout

| Path | Contents |
|---|---|
| `programs/learned-markets` | Anchor 1.2.2 program: `Config` / `Participant` / `WalletBinding` / `Intent` PDAs, the shared guard (`gate.rs`), SAS and Token-2022 decoding (`sas.rs`), canonical payloads (`payload.rs`), settlement boundary (`settlement.rs`) |
| `programs/gate-test-consumer` | Test-only CPI caller. Never deploy it outside test environments. |
| `tests/program-tests` | LiteSVM suite, kept as a **separate Cargo workspace** (see Toolchain). Loads the real devnet SAS binary. |
| `packages/attestations` | TypeScript schema codecs, verifier, gate client, and the operator CLI (`lm-attest`) |
| `apps/attestation-service` | HTTP service: SQLite index, challenges, sessions, intent admission, badge metadata, plus the operator CLI for approvals and resumable operations |
| `fixtures/` | Shared cross-language vectors and real on-chain account bytes |
| `scripts/rollout.ts` | End-to-end rollout demonstration. It writes `docs/rollout/<network>.json`. |

Program IDs: `learned_markets` = `nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz`, `gate_test_consumer` = `ZwKZ5pjQuiEr6AbHCj4BibaCLfyagQj8Ye4nfHRRx4q`. The program keypairs live in `target/deploy/` (git-ignored). Back them up, or redeploy under new IDs.

Pinned versions: `@solana/attestation@2.1.0`, `@solana/kit@8.3.0`, `@solana-program/token-2022@0.19.0` (the newest release whose peer range accepts kit 8.3), `anchor-lang@1.2.2`, `solana-attestation@2.0.0`. Both lockfiles are committed.

## Schema `learned-markets-participant` v1

The credential is **Learned Markets Demo Issuer**. Its credential authority (which owns the schema and can pause it) and its issuance signer (the only authorized attestation signer) are separate keys.

| Field | SAS type | Rule (enforced on chain and in the TS verifier) |
|---|---|---|
| `app_scope` | String (12) | exactly `learned-markets:demo` |
| `participant_id` | VecU8 (13) | exactly 32 random bytes, stable across wallet changes |
| `wallet` | VecU8 (13) | exactly 32 bytes, the bound wallet |
| `verification_method` | U8 (0) | `0` = operator-approved test participant |
| `binding_version` | U32 (2) | ≥ 1, increases by exactly 1 on every replacement or renewal |
| `issued_at` | I64 (8) | Unix seconds, at most 30 s ahead of the on-chain clock |

Rules on the outer SAS fields:

- `expiry` must be non-zero, in the future, and no more than 7 days after `issued_at`. The default lifetime is 7 days.
- The SAS attestation nonce is deterministic: `sha256("learned-markets:attestation-nonce:v1" ‖ participant_id ‖ binding_version_le)`. Every (participant, version) pair therefore has exactly one attestation address, which makes duplicate issuance impossible and lets operators record intended addresses before submitting.
- The schema group's lifetime capacity is 1,000,000, and replacements and renewals count against it.
- The badge mint's size is computed from the actual extensions and encoded metadata (748 bytes with the default URI). Tests check that this equals the live account's size.

No personal data or raw external-provider identifiers go on chain. Participant IDs are pseudonymous, but they publicly link a participant's replacement attestations.

## The guard (`gate.rs`)

`require_eligible` runs inside every protected instruction: `submit_intent` and settlement validation. Registration and replacement call `verify_badge` plus their own registry checks. No instruction accepts an earlier "verification succeeded" transaction as authorization. It checks:

- Config and participant are canonical PDAs owned by the program, the participant is `Active`, and the wallet binding is the active binding for its current wallet.
- SAS accounts have the right owner and discriminator. The credential, its authority, the schema, its version and layout `[12,13,13,0,2,8]`, and the app scope all match the trusted values.
- The attestation's signer is in the credential's *current* `authorized_signers`, so rotating the issuance key invalidates outstanding badges.
- Payload lengths and semantics, the verification method, the participant ID, wallet and binding version, and the deterministic nonce.
- Expiry against the on-chain `Clock`.
- The badge: the canonical attestation mint is owned by Token-2022, is non-transferable, has SAS as mint authority, decimals 0 and supply 1, and is a `TokenGroupMember` of the schema mint. The token account SAS recorded must belong to the bound wallet and hold exactly 1.
- **Pauses:** in `Admission` mode (registration and new intents), the SAS schema pause and `config.admission_paused` both deny. `Standing` mode (admin replacement, settlement of already-admitted intents) ignores pauses but applies every other check. A visible badge alone never proves eligibility.

## Instructions

| Instruction | Signers | Notes |
|---|---|---|
| `initialize_config` | program upgrade authority | Pins the SAS trust anchors and derives the schema mint and SAS authority |
| `update_config` | admin | Admission pause, admin transfer, settlement authority |
| `register_participant` | attested wallet | `init` rejects an existing participant or any existing wallet binding |
| `suspend_participant` / `revoke_participant` | admin | Revocation is terminal |
| `replace_binding` | admin + new wallet | Participant must be `Suspended`. The new badge must be `binding_version + 1` for the same participant. Retires the old binding atomically. Omit `old_wallet_binding` for a same-wallet renewal. A wallet ever bound to another participant is refused. |
| `submit_intent` | current wallet | Exact next nonce. Deadline ≤ now + 300 s and ≤ badge expiry. |
| `cancel_intent` | current wallet | Works regardless of pause, expiry, suspension or revocation |
| `settle_batch` | settlement authority | Runs every reusable check (eligibility, ownership, target, payload hash, expiry, binding version, replay, duplicates), then returns `SettlementNotImplemented` before any intent is touched |

Intent payload hash (identical in Rust and TS, with vectors in `fixtures/intent-payload-vectors.json`):

```
sha256( len‖"learned-markets:intent-payload" ‖ u8 1 ‖ len‖app_scope ‖ len‖network ‖ u8 kind ‖ target ‖ len‖contents )
trade contents      = u8 1 ‖ u8 side(0 buy,1 sell) ‖ u8 n(1..16) ‖ n × (u64 price ‖ u64 quantity)   // prices strictly ascending
nomination contents = u8 1 ‖ candidate(32)
```

Settlement (`settlement.rs`): `ValidatedBatch` can only be built by `validate_batch`. `execute(engine, batch)` calls `engine.apply` and then consumes the intents in the same instruction, so consumption and the economic state changes happen atomically. The only engine, `NotImplementedEngine`, returns an error. Custody, deposits, reservations, fill maths, fees, transfers and any generic CPI are deliberately left out. Escrow versus another settlement model is still an open decision.

## Service (`apps/attestation-service`)

| Route | Purpose |
|---|---|
| `POST /v1/challenges` `{wallet, action: enroll\|replace\|session, replacesWallet?}` | Returns a single-use challenge, valid for 5 minutes, that binds origin, wallet, action, nonce and expiry |
| `POST /v1/enrollments` / `POST /v1/replacements` `{challengeId, signature}` | Signed requests, held pending until an operator approves. There is no self-issuance endpoint. |
| `GET /v1/enrollments/:id`, `POST …/registration-transaction`, `POST …/confirm` | Status, the unsigned `register_participant` transaction for the wallet, and a check of both systems before access is granted |
| `POST /v1/replacements/:id/transaction`, `POST …/signature` | The new wallet signs `replace_binding`. The operator co-signs it as admin and fee payer. |
| `POST /v1/sessions`, `DELETE /v1/sessions` | Opaque token in an HttpOnly, Secure, SameSite=Strict cookie, 15-minute lifetime, stored hashed. Only eligible wallets get one. |
| `GET /v1/me`, `GET /v1/wallets/:wallet/eligibility` | `attestationValid`, `registryActive`, `eligible`, structured `reasons`, observed `slot` |
| `GET /v1/attestations/:address` | Attestation inspection |
| `POST /v1/intents/prepare`, `POST /v1/intents/admit` | Builds the canonical payload and unsigned `submit_intent`. Admits a request only once the matching intent is confirmed on chain and its hash matches. |
| `GET /v1/badge/metadata.json`, `GET /v1/badge/image.svg` | Public default badge metadata and artwork |

Every privileged request re-reads chain state at `confirmed`, and nothing caches a positive authorization. If the RPC fails, the request gets a 503 and is denied. Cross-origin state-changing requests are rejected. The on-chain registry is authoritative for bindings. The SQLite `registry_index` is only a derived index (`operator index:sync`).

Operations are resumable. The intended addresses and each transaction's signature are persisted *before* it is sent. A submitted transaction is reconciled (`confirmed` / `pending` / `failed` / `expired`) before any retry. Each step first checks the chain for its effect, so a rerun is idempotent. A failed operation leaves the participant suspended and ineligible; the old binding is never quietly restored.

Configuration:

- `SERVICE_ORIGIN` and `BADGE_METADATA_ORIGIN` must be HTTPS, except for localhost.
- `DB_PATH`
- `LM_RPC_URL`
- `LM_NETWORK`
- `OPERATOR_PAYER` (a public address, used as fee payer for co-signed replacements)

## Toolchain

- **Rust via rustup** (`cargo-build-sbf` requires it), Rust ≥ 1.98 for the agave 4.4 crates, Solana CLI 4.4, Anchor CLI 1.2.2, Node ≥ 24.12 (the TypeScript runs directly with type stripping, so there's no build step).
- `tests/program-tests` is its own Cargo workspace. litesvm 0.18 pins `solana-address ~2.7`, while `solana-attestation 2.0.0` requires `^2.8`, so the two can't share a dependency graph. The harness loads the compiled `.so` files and encodes instructions itself. Discriminators and error codes come from the IDL, and the TS tests check the same bytes.

```sh
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
anchor build                                         # programs + IDL
cargo test -p learned-markets                        # unit tests + shared vector generation check
(cd tests/program-tests && cargo test)               # on-chain suite (LiteSVM + real SAS)
npm install && npm run typecheck && npm test         # TS package + service
```

## Rollout

1. ✅ Pinned SAS codecs and the tokenized-attestation lifecycle, validated against the devnet SAS binary (`tests/program-tests`).
2. ✅ Registry, guard and intents, built and tested locally: 33 LiteSVM tests plus a smoke test.
3. ⏳ **Devnet deploy: blocked on funding.** The devnet faucet rate-limited this machine. Deploying the 412 KB program needs about 3 SOL. Fund `keys/deployer.json` and `keys/payer.json` (faucet.solana.com), then:
   ```sh
   solana program deploy -u devnet --keypair keys/deployer.json --upgrade-authority keys/deployer.json \
     --program-id target/deploy/learned_markets-keypair.json target/deploy/learned_markets.so
   LM_RPC_URL=https://api.devnet.solana.com LM_NETWORK=devnet \
     LM_BADGE_URI=https://<your-badge-origin>/v1/badge/metadata.json node scripts/rollout.ts
   ```
4. ✅ Operator tools and service indexing, exercised against a local validator running SAS cloned from devnet.
5. ✅ on localnet / ⏳ on devnet: two demo participants, gated admission, direct-call rejection, suspension, revocation and wallet replacement. All 26 steps passed. The record is in `docs/rollout/localnet.json`.
6. ⏳ Rendering in a compatible wallet needs a public HTTPS badge origin (`BADGE_METADATA_ORIGIN`) and a person to check it by eye. After the devnet run, open the replacement wallet recorded in `docs/rollout/devnet.json` in a Token-2022-aware wallet, and record the result here.

Operator keys come from `node packages/attestations/src/cli.ts keys:init`. They're written to `keys/` (git-ignored, mode 0600) and are loaded only by the operator CLIs.

## Defaults

- Operator-approved test identities.
- One active wallet per participant.
- Seven-day badge expiry.
- Intents last at most five minutes.
- Eligibility is enforced both on chain and in the service.

No real personhood-provider integration exists, and the system makes no human-only trading guarantee. Exchange settlement is a scaffold that does nothing yet.
