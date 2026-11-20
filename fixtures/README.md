# Shared TypeScript ⇄ Rust fixtures

| File | Produced by | Consumed by |
|---|---|---|
| `participant-attestation-vectors.json` | `cargo test -p learned-markets --test fixtures` | `packages/attestations/test/fixtures.test.ts` |
| `intent-payload-vectors.json` | same | same |
| `onchain-accounts.json` | `tests/program-tests` (`cargo test --test fixtures`): real account bytes and instruction data from a deterministic LiteSVM run against the devnet SAS binary | same |

Both generators fail if the committed file is stale. Regenerate with `UPDATE_FIXTURES=1` and commit the diff.

## Settlement parity

| File | Produced by | Consumed by |
| --- | --- | --- |
| `settlement-episode.json` | `python scripts/export-settlement-episode.py`, using Eren's shared core | LiteSVM `tests/program-tests/tests/ledger.rs` |
| `ledger-wire.json` | LiteSVM `parity_wire_fixtures`, with `UPDATE_FIXTURES=1` | Python generated-client and backend instruction tests |
| `settlement-vectors.json` | Hand-worked examples from the superseded full-v2 spec | Experimental TypeScript full-v2 helper tests |

The current backend and parity program use whole tokens, micro-lamport prices,
step curves and ppm seller fees from `settlement-interface.md`. The experimental
full-v2 examples retain that earlier design's units and fee schedule.
