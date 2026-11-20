# Session 2026-11-19: behaviours, coin survival, deployment, RL split

Design session (Eren + Claude), ~01:00–04:30 and 22:30 CST.

## What changed

- Wrote the behaviours list (prevent / don't restrict) → `docs/ai-gen/design/behaviours.md`.
- **Decided:** one wallet per person via identity attestation; no trading outside our venue (Token-2022); duplicates merge.
- **Tentative yes:** coin survival by countdown timer + replicator dynamics (drain = board-average activity). Losers' reserves flow to survivors; holders who stay to the end lose.
- **Proposed:** line → board → timers mechanism with rookie seats, square-root breadth, graduation by musical chairs, second chance by relaunch → `docs/ai-gen/design/board-and-timers.md`.
- **Proposed:** a second RL agent, the stage manager, that sets seats, rookie seats, drain multiplier and timer cap; never picks coins. Split RL into its own doc → `docs/ai-gen/design/rl-formulation.md`.
- **Proposed:** maker acts as one curve per batch (no last look), replacing the old per-order signed-quote gateway.
- **Proposed:** healthy-chart definition (8 components) and markout-based maker reward direction.
- **Proposed:** one fee formula (base + sell-speed + soft hold), fixed rule in v0, learned per person as the goal. Roadmap v0/v1/v2 written.

## What was rejected, and why

- Slot bidding / slot auctions, Harberger slots: not fun, not cold-start friendly, extra mechanism.
- Proposer bond: rejected by Eren.
- Presales: not wanted.
- Maker deciding coin death: conflict of interest, centralization/honeypot risk. Eren not 100% sure; revisit if a better argument appears.
- Hard-lock holds: honeypot-shaped.
- House launching coins directly: issuer, IP/likeness and conflict-of-interest risk.

## Key reasoning to remember

- With no outside venues, a delisted coin is untradeable; holders must be able to see death coming (public timers) and holds must release in the danger zone, or it's a honeypot.
- A sole maker is fine if it commits to a published curve each batch; spontaneity comes from early-entrant payoff, not from who quotes.
- The maker's main loss risk is inventory in a coin about to die, so coin timer is in its observation.
- Revenue from a fee must not feed the reward of whoever sets that fee.
- Sim traders must react to fees and holds, or any learned setter maxes them out.

## Open going into coding

- "Wealth tax": sell tax (assumed) vs holding tax.
- Reward weights, markout horizon, health weights.
- Clearing tie-breaking, curve parametrization, units/clocks, observation list (see "make concrete" list in `rl-formulation.md` → Roadmap v0).
- Who judges duplicate memes.

## Stale review (22:55–23:05)

- Team doc reviewed section by section; old AMM/gateway design, cluster detection, pump.fun-style graduation and the old per-order RL formulation dropped.
- Jito BAM: faded. Gemini bounty: not relevant.
- Manual trading only: reconfirmed.
- Referee/stabilizer split replaced by the team's two networks (auction network, quoting network).
- New requirement: dynamic launch fee that rises with launch volume.
- Competing learned markets: future idea, out of hackathon scope.
- Auction network = stage manager (same thing); the launch fee belongs to it.
- Still open: outside makers vs sole quoter; maker's starting inventory (unknown).

## Claude Docs (archive)

- Behaviours We Want to Prevent: https://claude.ai/artifact/4cVX8oUE3YodCVGBNZcfy6
- Learned Markets: RL & System Design (team doc, partly stale): https://claude.ai/artifact/3x3nKNDs244F4FfU9k81nM
- Learned Markets: RL Formulation: https://claude.ai/artifact/H62PD9M41moXiyuqBJegXL
