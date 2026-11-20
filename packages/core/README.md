# learned-markets-core

The market itself: tick grid, ledger, curve orders, uniform-price batch clearing,
trading terms, the quoter interface and coin lifecycle. Batch-first torch with
integer quantities. No Gym and no simulation code; the simulator, the trainer and
the backend all call `step_batch`.


Imported from Eren's working tree at `eren@chungus:/home/eren/repos/learned-markets/packages/core`
on 2026-11-20, following `origin/environment-design` commit `3920049`. The
package was uncommitted on Chungus at import time. Local integration adds an
integer ppm floor so float32 representation of the 1% base fee remains 10,000
ppm at the program boundary.
