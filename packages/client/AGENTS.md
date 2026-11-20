# Client package guidance

- Implement shared TypeScript integration with the Anchor program in this package.
- Read `README.md` here for the package's purpose and current state.
- Use Solana Kit and Codama-generated types/instructions from the Anchor IDL.
- Keep generated code separate from hand-written helpers; regenerate rather than
  manually editing generated output.
- Keep FastAPI routes in `apps/backend`, UI components in `apps/web`, and exchange
  execution/matching logic in the component selected by the market architecture.
- This scaffold has no client source or exports yet. Do not assume the SDK exists.
