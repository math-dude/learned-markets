# learned-markets-core

The market itself: tick grid, ledger, curve orders, uniform-price batch clearing,
trading terms, the quoter interface and coin lifecycle. Batch-first torch with
integer quantities. No Gym and no simulation code; the simulator, the trainer and
the backend all call `step_batch`.
