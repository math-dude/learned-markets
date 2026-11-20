# Earlier full-market settlement experiment

The active [settlement interface](../../docs/ai-gen/design/settlement-interface.md) follows
the Python market core. This workspace preserves an earlier full-market experiment.
Its interpolation and fee schedule belong to the superseded design.

The implemented modules cover integer price and allocation replay, finalized RPC log
subscriptions with signature backfill, SQLite deduplication, public event retrieval,
and the HTTP handlers for order intake and optional QuickNode delivery.
`npm test -w apps/settler` runs the local replay, ingestion and filter checks.
An executable trading loop, send/recovery logic, order-validation adapter and public
history verifier were unfinished when that design was superseded.

RPC ingestion uses a WebSocket subscription for live data and the HTTP RPC for
backfill. The optional QuickNode provisioner creates a Solana devnet block Stream
filtered to successful invocations of program
`nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz`. Its webhook payload carries
transaction signatures. The receiver fetches transactions from its configured RPC,
decodes program-owned logs and stores public activity for `GET /events`.
The web app reads this endpoint from `VITE_SETTLER_URL` (default same origin).

Once a relayer is serving a public HTTPS `/stream` endpoint, configure
`STREAM_WEBHOOK_URL`, a shared `STREAM_WEBHOOK_TOKEN`, and `QUICKNODE_API_KEY`,
then run `node scripts/create-quicknode-stream.ts` from the repo root. It prints
the provider's Stream ID and status. The token authenticates webhook deliveries.
The provisioner uses a stable external ID derived from the destination URL.
This repository has no live Stream receipt.
