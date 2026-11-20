# Board Mechanism: Seats, Timers and the Stage Manager

> **Status:** proposal. All numbers are placeholders for the simulator.

## Overview

Coins compete for a limited number of seats on a board. Each seated coin keeps its seat with a
timer that broad trading activity refills and a relative drain empties. An RL agent, the
**stage manager**, tunes the size and pace of the board but never picks which coins live or die.

## Components

| Component | Description |
| --- | --- |
| **The board** | `S` seats where coins trade normally, with the learned maker absorbing leftover flow. |
| **Rookie seats** | `P` of the `S` seats are reserved for coins younger than `A` hours, like airline protected seats. |
| **The line** | Where every new coin starts. It trades for real, but with a small per-person cap. It is a low-stakes lower division, not a presale. |
| **The stage manager** | An RL agent that sets `S`, `P` and the drain rate. It never chooses which coins live or die. |

## Coin Lifecycle

1. **Launch.** Any verified person can launch a meme. A coin that duplicates an existing one is
   merged into it. The new coin enters the line.
2. **Heat in the line.** Trading in the line builds the coin's *heat score*, measured as fees
   paid by distinct people.
3. **Seating.** Every epoch (for example, hourly), the hottest coins in the line take any open
   rookie seats. Each seated coin opens with a single batch auction at one clearing price, so
   nobody can snipe it.
4. **The timer.** Every batch, a seated coin's timer updates as described in
   [Timer Mechanics](#timer-mechanics).
5. **Graduation.** After `A` hours, a rookie moves into the regular seats. If they are full, the
   regular coin with the lowest timer is cut (musical chairs).
6. **Death.** When the timer reaches zero, the coin is delisted. This is checked only at epoch
   boundaries, never mid-batch. Its curve reserve flows into the surviving coins' curves,
   weighted by their timers. Holders who stayed lose their position. The timer is public and
   turns red near zero, so no one is surprised.
7. **Second chance.** A dead meme can be relaunched into the line like any new coin. No extra
   rules are needed.

## Timer Mechanics

Each batch:

```text
timer += k × breadth(fees) − drain
```

- **Breadth** is the sum, over each person, of the square root of the fees they paid in the
  batch. Ten people paying 1 SOL each count more than one whale paying 10 SOL. This borrows the
  quadratic-funding idea (Buterin, Hitzig, Weyl), and it is what stops a single whale from
  keeping a coin alive.
- **Drain** equals `k ×` the board's average breadth. A coin at average activity holds level;
  above average it gains time, below average it loses time. This is the replicator rule.
- **Timer cap.** The timer is capped (for example, at 48 hours), so a hot coin cannot bank
  enough time to coast through a boring stretch.

## The Stage Manager Agent

**Cadence.** Acts once per epoch, on a slower timescale than the maker.

**Actions:**

- Seat count `S`
- Rookie seats `P`
- Drain multiplier, between 0.8 and 1.2
- Timer cap

Each action is bounded and published, and changes by at most one step per epoch. This is the
low-switching shelf idea: the board should not thrash.

**Observations:**

- Every coin's timer, breadth and fee flow
- Holder concentration
- Heat in the line
- Platform volume

**Reward:** long-term board health, decomposed per coin the way SlateQ decomposes a slate:

- Distinct active people
- Chart-health measures: drawdown recovery, concentration, largest single-batch move
- Rookie survival rate through graduation
- Minus a penalty for deaths that trap many holders

The agent never acts on individual coins. It shapes the room; the rules decide who leaves it.

## Two Agents, Two Clocks

| | Maker | Stage manager |
| --- | --- | --- |
| **Timescale** | Every batch | Every epoch (hourly) |
| **Action** | A curve | `S`, `P`, drain, timer cap |
| **Goal** | Absorb imbalance, keep charts healthy | Keep the board healthy, give fresh memes a shot |

## Threats and Mitigations

| Threat | Mitigation |
| --- | --- |
| Copycat coins | Merged at launch. |
| Sniping | Small per-person caps in the line; every coin opens with a single batch auction. |
| A whale keeping a coin alive | Square-root breadth weighting. |
| Wash trading | Identity plus fees: fees paid always exceed the timer value they buy. |
| Cutoff timing tricks | Death is checked only at epoch boundaries; timers update at batch close. |
| Cold start | The agent can run few seats and many rookie seats. |
| Platform volume swings | Drain is relative to the board average, and the agent can resize the board. |

## Open Parameters for the Simulator

| Parameter | Meaning |
| --- | --- |
| `S` | Total seats on the board |
| `P` | Rookie seats |
| `A` | Rookie age limit (hours) |
| `k` | Breadth-to-timer conversion rate |
| Timer cap | Maximum banked time |
| Epoch length | Seating and death-check interval |
| Line cap | Per-person trading cap in the line |
| Reserve split | How a dead coin's reserve is divided among survivors |
