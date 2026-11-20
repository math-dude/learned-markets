"""Static method and caveat text appended to summary.md by 04_summary.py."""

NOTES = """## How the labels are made

1. Every top-level program in `pump_txs.programs` gets a class (`program_labels.csv`):
   `infra` and `pump` are ignored; `terminal`, `aggregator`, `official`, `public_tool`, `dex` and
   `bot` come from the curated list (`program_labels_curated.csv`, with source and confidence);
   every other program is classed by how many distinct signers used it over the covered epochs:
   at most 50 signers is `unknown-private` (treated as a private bot program), at least 1,000 is
   `unknown-public` (probably an unlisted public product), in between is `unknown`.
2. A transaction takes the first matching label: terminal, bot (private program), user
   (aggregator / wallet router / pump.fun mobile router / public tool), unknown_public, unknown,
   bot (another DEX called directly next to pump), direct.
3. A wallet takes its most frequent transaction label, counting failed transactions too.
   `label_share` is that label's share of the wallet's transactions and `mixed` marks wallets
   below 80%.

## What is uncertain

- **Terminals that charge by fee transfer are invisible.** A terminal that calls pump directly
  and adds a SOL transfer to its fee wallet shows only `System` + pump in `programs`, exactly like
  a tipped script. Those transactions are in `direct`. The table "`direct` transactions by
  top-level program set" bounds it: the rows with `System` at top level contain every such
  terminal trade, together with every Jito-tipped bot trade. Telling them apart needs the transfer
  destinations (known fee wallets), which this export does not carry. Photon, BonkBot, Banana Gun,
  Maestro and Trojan each appear with only a few thousand signers through their programs, and
  BullX does not appear at all, so much of their flow is probably in `direct` or under an
  unnamed program.
- **The signer is the fee payer, not always the trader.** Sponsored and intent-filled
  transactions (seen on DFlow, OKX and the pump.fun mobile router) are signed by a relayer that
  pays the fee for many users. Such wallets carry `relayer_suspect = true` (at least 1,000 txs, at
  least half multi-signature). Their flow is human-originated but the wallet row is not a person;
  `pump_trades.user` / `amm_trades.user` hold the real trader for those transactions.
- **Names with `low` confidence are inferred from the vanity prefix of the program ID alone**
  (Trojan, Maestro, Ave.ai, MevX, Rango, the `*bot` programs). `medium` names come from one or two
  third-party directories (wassup.trenchscreener.ai, orbmarkets.io, the
  cpkt9762/solana-dex-program-dumps release table) or from URLs embedded in the on-chain binary;
  none was confirmed against the project's own documentation. Solscan labels could not be fetched.
- **The pump.fun mobile router (`6Vo3245...`) is classed `user`** as the official front end. Its
  name is a community label, supported by its sharing an upgrade authority with another
  pump.fun-operated program. If it should count as a terminal instead, change its class in the
  curated list and re-run.
- **About 600 short-lived program IDs** (each used about once per signer by thousands of signers,
  roughly 100 live at a time, program data since closed) form one unidentified product. It is
  kept as `unknown_public`. Fees paid vary widely across its users, which fits a retail product
  better than a wallet farm, but that is an inference.
- **Using a public router does not make a wallet human.** Arbitrage and volume bots route through
  Jupiter and through terminals' programs. The wallet table keeps `tx_per_active_day`, success
  share and create-slot buy share for every class so the same activity cut can be applied to
  `user` and `terminal` wallets.
- **Lighthouse is treated as neutral.** Some wallets add it to protect the user (a human signal)
  and bots use it as a cheap fail-fast guard.
- SOL volume counts bonding-curve `sol_amount` and PumpSwap trades in wSOL-quoted pools only.
- Per-wallet median fee and median compute units are transaction-weighted means of per-epoch
  approximate medians, not exact medians.
- Majority labels count failed transactions, so a wallet that spams failing bot transactions and
  occasionally trades through a terminal is labelled `bot`.
"""
