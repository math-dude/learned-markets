# Onchain client

This package is the shared **TypeScript SDK for the learned-markets Anchor
program**. Put the TypeScript onchain client implementation here so the web app
and future TypeScript services can share it.

It will contain:

- Account and instruction types generated from the Anchor IDL using Codama.
- Functions for constructing program instructions and transactions.
- Helpers for fetching and decoding program accounts.
- Hand-written convenience wrappers around the generated client, when needed.

Use `@solana/kit`. Keep generated output separate from hand-written wrappers;
do not edit generated files directly. The exact client API will follow the
onchain program as its interface is designed.

This is separate from `apps/backend`, the Python/FastAPI server, and `apps/web`,
the user interface. Server routes, matching logic, training, and UI components
belong in their respective components.

## Current state

Only the package manifest, TypeScript configuration, Solana Kit, and Codama tools
are present. There is no source entrypoint, generated SDK, or codegen command yet.
The workspace package name is `@learned-markets/client`; consumers can use it once
its exports and implementation exist.
