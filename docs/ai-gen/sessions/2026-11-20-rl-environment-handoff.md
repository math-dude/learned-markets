# RL environment handoff

Learned Markets is designing a one-coin environment for the hackathon. Start with the [decision log](../decisions.md), [market rules](../design/market-rules.md), and [RL formulation](../design/rl-formulation.md). Use the November 20 decisions for policy ownership and timing where the older RL draft differs.

## Current design

- User and quoter curves clear together at a single gross price that maximizes executed volume. When several prices tie on volume, choose the one nearest the previous clearing price. The opening reference and the equal-distance tie-break are open.
- The tentative v0 batch is sealed. The quoter locks a firm two-sided curve before the batch opens using completed-batch data, public signals, and its own balances. Incoming orders stay hidden from the quoter and other traders. Trader-side commitment verification is deferred. The proposed allocation gives users and the quoter equal priority, fills better prices first, and allocates ties at the clearing price pro rata. Publish fills and disclose inputs on the audit schedule.
- The quoter sets the coin-wide capacity policy within configured hyperparameters. The policy can use coin age, identity-linked positions, and recent fills. Stricter rookie inventory limits are the intended behavior. The quoter also learns fee and soft-hold bounds. Traders see the applicable terms before submitting, and the auctioneer applies them to every fill regardless of counterparty. Keep a fixed shared fee and hold schedule as the submission fallback. Test personalized terms expressed only through the quoter’s spread after the hackathon.
- Available cash and inventory are ledger constraints. Maker exposure limits lean toward configurable hyperparameters. The working revenue model starts with a fixed execution fee and room for a learned early-exit charge. Track platform fee revenue, fees allocated to the maker, and maker trading P&L separately. The fee split and the treatment of dead-coin reserves are open.

## Build next

1. Write worked examples for imbalanced orders, partial fills, and a batch with no crossing orders. In the same pass, specify fee-aware limit checks, integer rounding, and the effect of caps on executable quantity. Turn these examples into deterministic simulator tests.
2. Run a seeded one-coin episode with a plain-curve `no_op` and a rule-based quoter before PPO. The maker reward, markout horizon, and inventory valuation are open. Evaluate potential sell impact together with quantity filled, price-discovery lag after a genuine demand shock, and maker P&L. Potential sell impact compares a participant’s hypothetical liquidation with the same background flow without that sale.
3. Validate a small Pump.fun sample in parallel. Chungus has approximately 140 GB under `/data/ssd/jetstreamer/export`, spanning epochs 1074–1089. All 16 epochs had `_SUCCESS` markers and all 128 files passed basic Parquet header and footer checks. Reproducing historical fills and reserve changes is still pending. For comparisons, run the same seeded trader policies and shocks on both venues and let each generate its own fills.

## Checkout state

At the last implementation check, the Python simulation and training packages were still scaffolds. The `onchain-validation` ref still used `NotImplementedEngine` for settlement. The Python environment can proceed independently. A demo that shows devnet fills and balance changes needs settlement. The design edits in this handoff are working-tree changes on Chungus, alongside an existing `TODO.md` edit.
