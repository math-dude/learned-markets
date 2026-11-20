"""Simulator-driven Surfpool population: many enrolled demo wallets trading through the web API.

Every action is a browser-equivalent HTTP call: session challenges are signed by the
wallet key, launches and trades are prepared by the backend, signed locally, relayed
through /v1/wallet-transactions and admitted through /v1/intents/admit. Balances are
read from confirmed validator accounts.

People follow the simulator's crowd model (learned_markets_simulation): noise,
retail and informed types with per-person activity, risk share, signal error and
momentum; attention is drawn by stage visibility, heat and own holdings; hidden meme
values come from the simulator's Memes process.

With --replay the crowd model is replaced by real pump.fun order flow: each live coin
replays the first minutes of a real pump.fun coin's trades (scripts/build-pump-replay.py),
every real wallet in that tape is played by one population wallet, which also takes the
real wallet's address as its display name, and each trade keeps its side, timing and SOL size.

  node scripts/enroll-population.ts 48     # once, with the participant service running
  .venv/bin/python scripts/sim-population.py --wallets 48
"""

import argparse
import asyncio
import base64
import gzip
import json
import math
import os
import random
import subprocess
import sys
import time
from pathlib import Path

import httpx
import torch
from learned_markets_backend.chain import PROGRAM_ID, ledger_balance_address, ledger_position_address
from learned_markets_backend.generated.accounts.ledgerBalance import LedgerBalance
from learned_markets_backend.generated.accounts.ledgerPosition import LedgerPosition
from learned_markets_simulation.memes import Memes
from learned_markets_simulation.params import INFORMED, NOISE, RETAIL, SimConfig
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.message import to_bytes_versioned
from solders.transaction import VersionedTransaction

ROOT = Path(__file__).resolve().parent.parent
SIM = SimConfig()
VIS = {"Line": 1.0, "Rookie": 3.0, "Regular": 4.0}
BASE_FEE = 0.01
HANDLE_A = ["vice", "leonida", "lucia", "skibidi", "rizz", "sigma", "demure", "rot", "moodeng", "chill",
            "hawk", "trala", "labubu", "sixseven", "aura", "dubai", "mew", "gyatt", "fanum", "ohio", "delulu",
            "mog", "capy", "npc", "griddy", "slay", "bussin", "sahur", "pedro", "grimace"]
HANDLE_B = ["maxi", "lord", "farmer", "enjoyer", "king", "queen", "ape", "degen", "chad", "andy", "bro", "fan",
            "goblin", "whale", "scout", "vic"]
MEMES = json.loads((ROOT / "apps/web/public/memes/memes.json").read_text())
# Real-time pump.fun launch names; the sim crowd still drives every trade.
PUMP_FEED = Path(os.environ.get("PUMP_FEED", ROOT / ".pump-feed.json"))


def log(**event):
    print(json.dumps({"t": round(time.time(), 1), **event}), flush=True)


class Person:
    """One simulated crowd member bound to one enrolled wallet."""

    def __init__(self, index, keypair, rng):
        self.index, self.kp = index, keypair
        self.wallet = str(keypair.pubkey())
        draw = rng.random()
        self.kind = NOISE if draw < SIM.share_noise else INFORMED if draw > 1 - SIM.share_informed else RETAIL
        lo, hi = SIM.act_rate
        self.act = math.exp(math.log(lo) + (math.log(hi) - math.log(lo)) * rng.random())
        self.risk = SIM.risk_share[0] + (SIM.risk_share[1] - SIM.risk_share[0]) * rng.random()
        self.width = SIM.width[0] + (SIM.width[1] - SIM.width[0]) * rng.random()
        self.sd = SIM.signal_sd[self.kind]
        self.beta = SIM.momentum[self.kind] * rng.random()
        self.eps = {}  # private error per market
        self.cookie = None
        self.participant = None
        self.cash = 0
        self.positions = {}
        self.busy = False
        self.real = None  # the real pump.fun wallet this one plays in replay mode
        self.touched = set()  # markets this wallet has ordered in; others have no position yet


class Population:
    def __init__(self, args):
        self.args = args
        self.service = args.service.rstrip("/")
        self.origin = os.environ.get("SERVICE_ORIGIN", self.service)
        self.rng = random.Random(args.seed + args.start)
        self.gen = torch.Generator().manual_seed(args.seed)
        self.memes = Memes(1, args.slots, SIM, "cpu", self.gen)
        self.slot_of = {}  # market -> meme slot
        self.markets = {}  # live market address -> board entry
        self.ret_ema = {}
        self.last_x = {}
        self.board_slot, self.batch_slots = 0, 32
        self.per_batch = {}  # (market, batch) -> participants admitted
        self.launches = 0
        self.stats = {"orders": 0, "buy": 0, "sell": 0, "launch": 0, "errors": 0}
        self.next_meme = self.rng.randrange(len(MEMES))
        self.used_names = set()
        self.pump_used = set()
        # Replay mode: real pump.fun tapes, and per live market its tape, start time and cast.
        self.tapes = [json.loads(line)["trades"] for line in gzip.open(args.replay, "rt")] if args.replay else []
        self.script = {}
        keys = ROOT / "keys/market-demo/surfpool"
        self.people = [
            Person(i, Keypair.from_json((keys / f"population-{i:02d}.json").read_text()), self.rng)
            for i in range(args.start, args.start + args.wallets)
        ]

    # ------------------------------------------------------------------ HTTP as the browser does it
    async def call(self, person, method, path, body=None):
        headers = {"content-type": "application/json", "origin": self.origin}
        if person and person.cookie:
            headers["cookie"] = person.cookie
        r = await self.http.request(method, self.service + path, headers=headers, json=body)
        if "set-cookie" in r.headers:
            person.cookie = r.headers["set-cookie"].split(";")[0]
        if r.status_code >= 300:
            raise RuntimeError(f"{method} {path} -> {r.status_code} {r.text[:200]}")
        return r.json() if r.content else None

    async def session(self, person):
        ch = await self.call(person, "POST", "/v1/challenges", {"wallet": person.wallet, "action": "session"})
        sig = person.kp.sign_message(ch["message"].encode())
        await self.call(person, "POST", "/v1/sessions", {"challengeId": ch["challengeId"], "signature": str(sig)})
        me = await self.call(person, "GET", "/v1/me")
        if not me.get("eligible"):
            raise RuntimeError(f"{person.wallet} is not eligible; run scripts/enroll-population.ts")
        person.participant = Pubkey.from_string(me["participant"]["address"])
        if not getattr(person, "named", False) and not self.tapes:
            i = person.index
            handle = f"{HANDLE_A[i % len(HANDLE_A)]}_{HANDLE_B[(i // len(HANDLE_A)) % len(HANDLE_B)]}{i // 480 or ''}"
            try:
                await self.call(person, "POST", "/api/profile", {"username": handle[:16]})
                person.named = True
            except RuntimeError as exc:
                log(event="profile-error", wallet=person.wallet[:8], error=str(exc)[:160])

    async def relay(self, person, prepared):
        # Prepared transactions may be legacy or v0; sign the message bytes in our signer slot.
        tx = VersionedTransaction.from_bytes(base64.b64decode(prepared["transactionBase64"]))
        msg = tx.message
        slot = list(msg.account_keys).index(person.kp.pubkey())
        sigs = list(tx.signatures)
        sigs[slot] = person.kp.sign_message(to_bytes_versioned(msg))
        tx = VersionedTransaction.populate(msg, sigs)
        return await self.call(
            person, "POST", "/v1/wallet-transactions", {"transactionBase64": base64.b64encode(bytes(tx)).decode()}
        )

    async def authed(self, person, method, path, body=None):
        try:
            return await self.call(person, method, path, body)
        except RuntimeError as exc:
            if "-> 401" not in str(exc) and "-> 403" not in str(exc):
                raise
            await self.session(person)
            return await self.call(person, method, path, body)

    # ------------------------------------------------------------------ confirmed reads
    async def refresh(self, person):
        keys = [ledger_balance_address(person.participant)]
        # Only read positions that can exist: absent accounts are slow on a forked Surfpool.
        live = [m for m in self.markets if m in person.touched]
        keys += [ledger_position_address(Pubkey.from_string(m), person.participant) for m in live]
        values = (await self.rpc.get_multiple_accounts(keys, commitment="confirmed")).value
        ok = lambda raw: raw is not None and raw.owner == PROGRAM_ID
        person.cash = LedgerBalance.decode(values[0].data).cash if ok(values[0]) else None
        person.positions = {
            m: LedgerPosition.decode(raw.data).tokens for m, raw in zip(live, values[1:], strict=True) if ok(raw)
        }

    async def seed(self, person, refill):
        args = ["scripts/seed-surfpool-balance.py", person.wallet] + (["--refill"] if refill else [])
        proc = await asyncio.create_subprocess_exec(
            sys.executable, *args, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        await proc.wait()

    async def poll_board(self):
        while True:
            try:
                r = await self.http.get(self.service + "/api/chain")
                board = r.json()
                self.board_slot, self.batch_slots = board["slot"], board["batch_slots"]
                live = {m["address"]: m for m in board["markets"] if m["live"]}
                for addr, m in live.items():
                    if addr not in self.slot_of:
                        self.assign_slot(addr)
                    x = math.log(max(int(m["price"] or 0), 1))
                    if addr in self.last_x:
                        ret = x - self.last_x[addr]
                        self.ret_ema[addr] = 0.8 * self.ret_ema.get(addr, 0.0) + 0.2 * ret
                    self.last_x[addr] = x
                for addr in set(self.slot_of) - set(live):
                    del self.slot_of[addr]
                    self.script.pop(addr, None)
                self.markets = live
                for addr in live:
                    if self.tapes and addr not in self.script and self.owns(addr):
                        tape = self.tapes[self.rng.randrange(len(self.tapes))]
                        self.script[addr] = {"t0": time.time(), "trades": tape, "i": 0, "cast": {}}
            except Exception as exc:  # the backend may be restarting
                log(event="board-error", error=str(exc)[:200])
            await asyncio.sleep(2.5)

    def assign_slot(self, addr):
        used = set(self.slot_of.values())
        free = [s for s in range(self.args.slots) if s not in used]
        if not free:
            return
        slot = free[0]
        self.slot_of[addr] = slot
        mask = torch.zeros(1, self.args.slots, dtype=torch.bool)
        mask[0, slot] = True
        self.memes.reset(mask)

    async def step_memes(self):
        # Hidden values advance once per settlement window, like a simulator batch.
        while True:
            live = torch.zeros(1, self.args.slots, dtype=torch.bool)
            ret = torch.zeros(1, self.args.slots)
            for addr, slot in self.slot_of.items():
                live[0, slot] = True
                ret[0, slot] = self.ret_ema.get(addr, 0.0)
            self.memes.step(live, ret)
            await asyncio.sleep(self.batch_slots * 0.4)

    def owns(self, addr):
        # Workers own disjoint markets so the per-market batch cap holds across processes.
        n = self.args.shards
        return n == 1 or Pubkey.from_string(addr).__bytes__()[0] % n == self.args.shard

    # ------------------------------------------------------------------ crowd behaviour
    def pick_coin(self, person):
        live = [a for a in self.markets if a in self.slot_of and self.owns(a)]
        if not live:
            return None
        weights = []
        for a in live:
            m = self.markets[a]
            pop = VIS.get(m["stage"], 1.0) * (1 + float(m.get("heat") or 0)) ** SIM.heat_power
            weights.append(pop * (1 + SIM.hold_boost * (person.positions.get(a, 0) > 0)))
        return self.rng.choices(live, weights)[0]

    def decide(self, person, addr):
        m = self.markets[addr]
        price = int(m["price"] or 0) or 28_000_000
        x = math.log(price)
        slot = self.slot_of[addr]
        value = float((self.memes.log_value if person.kind == INFORMED else self.memes.slow)[0, slot])
        launch_x = math.log(28_000_000)
        eps = person.eps.setdefault(addr, self.rng.gauss(0, person.sd))
        rho = SIM.signal_rho
        person.eps[addr] = eps = rho * eps + math.sqrt(1 - rho * rho) * person.sd * self.rng.gauss(0, 1)
        view = x + 0.3 * eps if person.kind == NOISE else value + launch_x + eps
        view += person.beta * self.ret_ema.get(addr, 0.0)
        hold = person.positions.get(addr, 0)
        wealth = (person.cash or 0) + hold * price / 1_000_000
        # Demo wallets spread a smaller share across many coins so they keep trading.
        budget = person.risk * wealth * self.args.budget_scale
        tokens = budget * 1_000_000 / price
        target_buy = tokens * min(1, max(0, (view - x - 2 * BASE_FEE) / person.width))
        target_sell = tokens * min(1, max(0, (view - x + BASE_FEE) / person.width))
        if hold > 0 and self.rng.random() < SIM.liquidity_sell * 10:
            return "sell", int(hold * self.rng.uniform(0.2, 1.0)), price
        if target_buy > hold:
            return "buy", int(target_buy - hold), price
        if hold > target_sell:
            return "sell", int(min(hold, hold - target_sell)), price
        return None, 0, price

    async def trade(self, person):
        addr = self.pick_coin(person)
        if not addr:
            return
        batch = self.board_slot // self.batch_slots
        key = (addr, batch)
        seats = self.per_batch.setdefault(key, set())
        if len(seats) >= self.args.per_batch or person.wallet in seats:
            return
        side, qty, price = self.decide(person, addr)
        await self.submit(person, addr, seats, side, qty, price)

    async def submit(self, person, addr, seats, side, qty, price):
        dust = 5_000_000 * 1_000_000 // price + 1  # tokens below dust do not count as trading
        if side == "buy":
            qty = max(qty, dust)
            if (person.cash or 0) < qty * price // 1_000_000 + 10_000_000:
                return
            limit = price * 3 // 2
        elif side == "sell":
            if qty < dust // 2:
                return
            limit = max(1, price * 2 // 3)
        else:
            return
        seats.add(person.wallet)
        person.touched.add(addr)
        prepared = await self.authed(
            person,
            "POST",
            "/v1/intents/prepare",
            {"kind": "trade", "target": addr, "trade": {"side": side, "points": [{"price": str(limit), "quantity": str(qty)}]}},
        )
        await self.relay(person, prepared)
        await self.authed(
            person,
            "POST",
            "/v1/intents/admit",
            {"intent": prepared["intent"], "expectedTarget": addr, "expectedKind": "trade"},
        )
        self.stats["orders"] += 1
        self.stats[side] += 1

    # ------------------------------------------------------------------ real pump.fun order flow
    def cast(self, script, wallet):
        """The population wallet that plays `wallet` in this coin; it keeps that role and name."""
        person = script["cast"].get(wallet)
        if not person:
            taken = {p.wallet for p in script["cast"].values()}
            free = [p for p in self.people if p.participant and p.wallet not in taken]
            # Prefer a wallet that already carries this real address, then one without a name yet.
            pool = (
                [p for p in free if p.real == wallet]
                or [p for p in free if not p.real]
                or free
                or [p for p in self.people if p.participant]
            )
            person = script["cast"][wallet] = self.rng.choice(pool)
            if not person.real:
                person.real = wallet
                asyncio.ensure_future(self.rename(person, f"{wallet[:6]}_{wallet[-6:]}"))
        return person

    async def rename(self, person, username):
        try:
            await self.authed(person, "POST", "/api/profile", {"username": username})
        except Exception as exc:
            person.real = None  # another worker already plays this wallet; take the next one
            if "-> 409" not in str(exc):
                log(event="profile-error", wallet=person.wallet[:8], error=str(exc)[:160])

    async def replay_trade(self, person, addr, seats, is_buy, lamports):
        price = int(self.markets[addr]["price"] or 0) or 28_000_000
        lamports = int(lamports * self.args.replay_scale)
        if is_buy:
            # The real size, within what this wallet can fund.
            lamports = min(lamports, int((person.cash or 0) * 0.3))
            side, qty = "buy", lamports * 1_000_000 // price
        else:
            hold = person.positions.get(addr, 0)
            qty = min(hold, lamports * 1_000_000 // price)
            side, qty = "sell", hold if qty > 0.8 * hold else qty
        try:
            person.busy = True
            await self.submit(person, addr, seats, side, qty, price)
        except Exception as exc:
            self.stats["errors"] += 1
            log(event="error", wallet=person.wallet[:8], error=repr(exc)[:240])
        finally:
            person.busy = False

    async def replay_loop(self):
        while True:
            await asyncio.sleep(0.2)
            now = time.time()
            batch = self.board_slot // self.batch_slots
            for addr, script in list(self.script.items()):
                if addr not in self.markets:
                    continue
                if script["i"] >= len(script["trades"]):
                    # The real coin's tape is over; the market carries on with another coin's flow.
                    script.update(trades=self.tapes[self.rng.randrange(len(self.tapes))], t0=now, i=0)
                trades, clock = script["trades"], (now - script["t0"]) * self.args.replay_speed
                quiet = trades[script["i"]][0] - clock - self.args.replay_max_gap
                if quiet > 0:
                    # Skip the long silences of a real tape so a live market keeps trading.
                    script["t0"] -= quiet / self.args.replay_speed
                    clock += quiet
                seats = self.per_batch.setdefault((addr, batch), set())
                while script["i"] < len(trades) and trades[script["i"]][0] <= clock:
                    at, wallet, is_buy, lamports = trades[script["i"]]
                    person = self.cast(script, wallet)
                    full = len(seats) >= self.args.per_batch or person.wallet in seats or person.busy
                    if full and clock - at < self.args.replay_patience:
                        break  # wait for a seat in a later batch
                    script["i"] += 1
                    if full:
                        self.stats["dropped"] = self.stats.get("dropped", 0) + 1
                    else:
                        person.busy = True
                        seats.add(person.wallet)  # hold the seat now: the order is placed asynchronously
                        asyncio.ensure_future(self.replay_trade(person, addr, seats, is_buy, lamports))

    def pump_meme(self):
        """Newest unused pump.fun launch name (scripts/pump-feed.py), else None."""
        try:
            feed = json.loads(PUMP_FEED.read_text())
        except (OSError, ValueError):
            return None
        for token in feed:
            if token["ticker"] in self.pump_used or token["name"] in self.used_names:
                continue
            self.pump_used.add(token["ticker"])
            art = MEMES[self.rng.randrange(len(MEMES))]["image"]
            return {"name": token["name"], "ticker": token["ticker"], "image": token.get("image") or art}
        return None

    async def launch(self, person):
        meme = self.pump_meme() or MEMES[self.next_meme % len(MEMES)]
        self.next_meme += self.rng.randrange(1, 7)
        n = 1
        name = meme["name"]
        while name in self.used_names:
            n += 1
            name = f"{meme['name'][: 32 - len(str(n)) - 2]} #{n}"
        self.used_names.add(name)
        try:
            prepared = await self.authed(
                person, "POST", "/api/chain/launch", {"name": name, "ticker": meme["ticker"], "image": meme["image"]}
            )
        except RuntimeError as exc:
            if "already exists" in str(exc):
                return await self.launch(person)
            raise
        await self.relay(person, prepared)
        self.stats["launch"] += 1
        log(event="launch", name=name, ticker=meme["ticker"], market=prepared["market"], live=len(self.markets))

    # ------------------------------------------------------------------ loops
    async def person_loop(self, person):
        await asyncio.sleep(self.rng.random() * 5)
        while True:
            try:
                await self.refresh(person)
                if person.cash is None:
                    await self.seed(person, False)
                elif person.cash < 400_000_000:
                    await self.seed(person, True)
                    log(event="refill", wallet=person.wallet)
                elif not self.tapes:
                    person.busy = True
                    # Simulated act rates are per 10 s batch; the demo compresses time.
                    if self.rng.random() < min(1.0, person.act * self.args.activity):
                        await self.trade(person)
                    person.busy = False
            except Exception as exc:
                self.stats["errors"] += 1
                log(event="error", wallet=person.wallet[:8], error=repr(exc)[:240])
                person.busy = person.busy and bool(self.tapes)
                await asyncio.sleep(2)
            await asyncio.sleep(self.rng.uniform(0.3, 1.2))

    async def launch_loop(self):
        # Launches run concurrently so the rate is not bounded by one confirmation round trip.
        inflight = asyncio.Semaphore(self.args.launch_concurrency)

        async def one(person):
            async with inflight:
                try:
                    await self.launch(person)
                except Exception as exc:
                    self.stats["errors"] += 1
                    log(event="launch-error", error=repr(exc)[:240])

        while True:
            await asyncio.sleep(self.rng.uniform(self.args.launch_min, self.args.launch_max))
            if len(self.markets) >= self.args.max_live or inflight.locked():
                continue
            candidates = [p for p in self.people if p.participant and (p.cash or 0) > 600_000_000]
            if candidates:
                asyncio.ensure_future(one(self.rng.choice(candidates)))

    async def report_loop(self):
        while True:
            await asyncio.sleep(15)
            cutoff = self.board_slot // self.batch_slots - 4
            self.per_batch = {k: v for k, v in self.per_batch.items() if k[1] >= cutoff}
            log(event="stats", worker=self.args.start, live=len(self.markets), **self.stats)

    async def run(self):
        async with httpx.AsyncClient(timeout=30) as http, AsyncClient(self.args.rpc, commitment="confirmed") as rpc:
            self.http, self.rpc = http, rpc
            for person in self.people:
                for attempt in range(4):
                    try:
                        await self.session(person)
                        break
                    except Exception as exc:
                        if attempt == 3:
                            raise
                        log(event="session-retry", wallet=person.wallet, error=str(exc)[:200])
                        await asyncio.sleep(2)
            log(event="ready", wallets=len(self.people))
            await asyncio.gather(
                self.poll_board(),
                self.step_memes(),
                *([self.launch_loop()] if self.args.launch_max > 0 else []),
                self.report_loop(),
                *([self.replay_loop()] if self.tapes else []),
                *(self.person_loop(p) for p in self.people),
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--service", default=os.environ.get("SERVICE_URL", "http://127.0.0.1:5173"))
    parser.add_argument("--rpc", default=os.environ.get("LM_RPC_URL", "http://127.0.0.1:8899"))
    parser.add_argument("--wallets", type=int, default=48)
    parser.add_argument("--start", type=int, default=0, help="first population wallet index for this worker")
    parser.add_argument("--slots", type=int, default=96, help="meme value slots for concurrently live coins")
    parser.add_argument("--launch-concurrency", type=int, default=8)
    parser.add_argument("--max-live", type=int, default=32, help="pause launches above this many live coins")
    parser.add_argument("--launch-min", type=float, default=2.0)
    parser.add_argument("--launch-max", type=float, default=4.0, help="0 disables launches in this worker")
    parser.add_argument("--per-batch", type=int, default=2,
                        help="participants per market per batch; 8 is the program max but only 2 fit one packet with position setup")
    parser.add_argument("--shard", type=int, default=0)
    parser.add_argument("--shards", type=int, default=1)
    parser.add_argument("--activity", type=float, default=4.0, help="multiplier on simulated act rates")
    parser.add_argument("--budget-scale", type=float, default=0.25)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--replay", help="real pump.fun tapes from scripts/build-pump-replay.py; replaces the crowd model")
    parser.add_argument("--replay-speed", type=float, default=1.0, help="tape seconds per real second")
    parser.add_argument("--replay-scale", type=float, default=1.0, help="multiplier on real trade sizes")
    parser.add_argument("--replay-max-gap", type=float, default=10.0,
                        help="longest silence, in tape seconds, replayed between two trades of a coin")
    parser.add_argument("--replay-patience", type=float, default=8.0,
                        help="tape seconds a trade waits for a batch seat before it is dropped")
    args = parser.parse_args()
    assert os.environ.get("LM_NETWORK", "surfpool") == "surfpool"
    assert args.per_batch <= 8
    asyncio.run(Population(args).run())


if __name__ == "__main__":
    main()
