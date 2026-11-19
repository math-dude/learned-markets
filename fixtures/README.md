# Shared TypeScript ⇄ Rust fixtures

| File | Produced by | Consumed by |
|---|---|---|
| `participant-attestation-vectors.json` | `cargo test -p learned-markets --test fixtures` | `packages/attestations/test/fixtures.test.ts` |
| `intent-payload-vectors.json` | same | same |
| `onchain-accounts.json` | `tests/program-tests` (`cargo test --test fixtures`): real account bytes and instruction data from a deterministic LiteSVM run against the devnet SAS binary | same |

Both generators fail if the committed file is stale. Regenerate with `UPDATE_FIXTURES=1` and commit the diff.
