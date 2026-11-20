# Learned Markets: AI-generated design context

Design docs produced with Claude in design sessions, cleaned 2026-11-19. Human-written planning lives in `docs/PLANNING.md`; where they conflict, check with the team.

A consumer memecoin exchange on Solana designed to prevent the toxic behaviours of today's launchpads (pump.fun and similar). Built for UBC Hackathon 2026 (DeFi & Onchain Apps, Best use of Solana, QuickNode Streams bounty). Submission due **Fri Nov 20, 2026, 12:00 PM CST**.

## Read this first

- **Guiding principle (decided 2026-11-16):** on our exchange, people make money by predicting which memes and trends get more popular. They do **not** make money by deploying fastest, sniping, or spreading supply across wallets. Check every mechanism against this.
- **Goal of the system:** a healthy chart (defined in `docs/ai-gen/design/rl-formulation.md`).
- **Tone of the product:** a consumer product, not a serious financial exchange. Not a honeypot, not a pure free market either. Prefer elegant, simple mechanisms; avoid looking like "one more launchpad".

## Decided policy

- One wallet per person, enforced by identity attestation (World ID, Solana Attestation Service, or similar).
- No trading on outside venues: token transfers restricted to our venue (Token-2022 transfer hooks).
- Duplicate coins are merged: one coin per meme.
- Sniping must not be an edge.
- No hidden supply, no multi-account buying.
- Manual trading only: no bots, no trading API, no automated copy-trading (enforcement open).
- Launching a coin costs a dynamic fee that rises when many people are launching (mechanism proposed).

Everything else is proposed, leaning or open. **Check `docs/ai-gen/decisions.md` before proposing anything**: it lists what was rejected and why.

## Core design in one paragraph (proposed)

Trading clears in batch auctions where every order is a curve. Users net against each other; a learned **maker** (the quoting network) posts one curve per batch and absorbs only the leftover imbalance. Coins live on a **board** with limited seats; every new coin starts in a low-stakes **line**. Each seated coin has a public **timer** fed by fees from distinct people (square-root weighted) and drained at the board's average rate; at zero the coin dies and its reserve flows to survivors. A second learned agent, the **auction network** (also called the stage manager), sets seat counts, rookie seats, drain rate, timer cap and the launch fee, but never picks which coins live.

## Where things live

| File | What |
| --- | --- |
| `docs/ai-gen/decisions.md` | Every decision with status, date and reason. Source of truth for what's settled. |
| `docs/ai-gen/design/behaviours.md` | Behaviours we prevent and those we don't restrict |
| `docs/ai-gen/design/market-rules.md` | Batch auction, curve orders, fees and holds, safety, public record |
| `docs/ai-gen/design/board-and-timers.md` | Line, board, timers, death, deployment |
| `docs/ai-gen/design/rl-formulation.md` | The two agents, healthy-chart definition, rewards, training, roadmap v0/v1/v2 |
| `docs/ai-gen/research/precedents.md` | Real-world and academic precedents, with links |
| `docs/ai-gen/sessions/` | Dated handoff notes from design sessions |

## Conventions

- Status words: **decided**, **leaning**, **proposed**, **open**, **rejected**. Don't present proposed items as decided.
- Code order: v0 first (one coin, maker only, fixed fee rule). See the roadmap in `rl-formulation.md`.
- Python 3.12; Stable-Baselines3 PPO; PettingZoo AEC env wrapped as Gymnasium. Simulator math must match on-chain math exactly (golden vectors).
- When a design session changes something, add a note in `docs/ai-gen/sessions/` and update `docs/ai-gen/decisions.md`.
