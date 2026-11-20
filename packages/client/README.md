# On-chain client

Import account decoders and instruction builders from `@learned-markets/client` or
`@learned-markets/client/generated`. The checked-in Codama bindings reflect the current
M1 IDL, including board initialization, token custody and stages. The active settlement
interface uses the Python market core and records whole-token and lamport balances.
Its program instructions will require regenerated bindings. See
[the settlement interface](../../docs/ai-gen/design/settlement-interface.md).

Regenerate after building the program with `anchor build`:

```sh
npm run generate -w packages/client
npm test -w packages/client
```

## Earlier full-market experiment

The `@learned-markets/client/settlement-v2` subpath preserves the superseded full-market
experiment. Its interpolated curves and per-position fee schedule are specific to that design.

The generator reads `target/idl/learned_markets.json`. Arithmetic uses bigint for
token amounts, timestamps, prices and batch IDs. JSON service requests use decimal
strings for wide integers. The shared tests check reveal bytes, hashes, integer
interpolation, fee rounding and the worked two-chunk ledger in
`fixtures/settlement-vectors.json`. Settlement transaction assembly takes instruction
builders supplied by the caller. The full-market M2 was paused before its IDL existed.
