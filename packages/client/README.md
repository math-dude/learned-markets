# On-chain client

Import account decoders and instruction builders from `@learned-markets/client` or
`@learned-markets/client/generated`. The generated bindings cover the M1 token custody accounts and
the separate simulation ledger used for parity with the Python market core.

The parity ledger uses five instructions:

- `getCreditLedgerBalanceInstruction` credits a participant's simulated cash on demo builds.
- `getOpenLedgerMarketInstruction` records the launch fee and initializes the reserve.
- `getInitializeLedgerPositionInstruction` creates the participant's record for the market.
- `getSettleLedgerBatchInstruction` applies an atomic batch in whole tokens and lamports.
  Pass the ledger market PDA as both `market` (account) and `marketArg` (request field).
  Its clearing price is expressed in micro-lamports per whole token. Append eight
  remaining accounts for each fill in request order: writable intent, participant,
  wallet binding, attestation, badge mint, badge token account, writable ledger
  balance, writable ledger position.
- `getCloseLedgerMarketInstruction` ends trading on the market.

Use `findOpenLedgerMarketMarketPda` and `findInitializeLedgerPositionPositionPda` for
ledger addresses. Codama derives their names from the instructions to distinguish them
from the custody market and position PDAs.

For units, the seller fee range and the reserve arithmetic, see
[the settlement interface](../../docs/ai-gen/design/settlement-interface.md).

After `anchor build`, regenerate from `target/idl/learned_markets.json` and run the tests:

```sh
npm run generate -w packages/client
npm test -w packages/client
```

## Earlier full-market experiment

The `@learned-markets/client/settlement-v2` subpath preserves the superseded full-market
experiment. Its interpolated curves and per-position fee schedule are specific to that design.

The experimental arithmetic uses bigint for
token amounts, timestamps, prices and batch IDs. JSON service requests use decimal
strings for wide integers. The shared tests check reveal bytes, hashes, integer
interpolation, fee rounding and the worked two-chunk ledger in
`fixtures/settlement-vectors.json`. Settlement transaction assembly takes instruction
builders supplied by the caller. The full-market M2 was paused before its IDL existed.
