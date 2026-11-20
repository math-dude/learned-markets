- [ ] Scrape trends from Tiktok (deferred)
- [ ] unify API of app operating with timelapse API (time in app should be a modular functionality, swap out actual time passage swap in some pretermined schedule )
  - [x] swappable clock exists (`apps/backend/.../clock.py`: real time or time-lapse); the API is not driven by it yet
- [ ] AI agents or bots trading the market
  - [x] simulated crowd and six scripted attackers trade the market in the simulator (`packages/simulation`)
  - [ ] make some api to sign up a bunch of bots and agents
- [ ] change the names for line, rookie, standard and other terms
- [ ] maybe we want to show what our market learns

- [x] solve the issue which is that we have npm in the attestation stuff and bun for the general project.
- [ ] integrate privy and sign in page (in progress)

- [x]  make sure the RL environment logic is reused for the backend logic (ensure modularity)
  - one core (`packages/core`) is called by the simulator, the trainer and both backend services; tests cover it

- [x] train the quoting network and the auction network, and grade them against pump (`docs/ai-gen/results/2026-11-20-evaluation.md`)
- [x] settlement interface doc and merge with the settlement program branch
- [ ] Pitch doc
- [ ] record different scenarios happening live (pump and dump, copy trading etc)
  - [x] simulated side by side, ours and pump's curve: scenario tables in the results doc, figures in `docs/ai-gen/results/figures`
  - [ ] 1: happening on our AMM (live)
  - [ ] what would have happened in pumpfun's AMM. (live)
  - [ ] copy trading (KOL with followers) scenario is not built


undecided:
- [ ] where do the launch fees go? do we view maker profits and fees as unified or seperate? do we view stage manager and quoter p&l as seperate or unified? surplus above maker safety buffer?
- [ ] what exactly happens to deadcoin liquidity?
