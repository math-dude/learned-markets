"""Scripted attackers, one per behaviour in docs/ai-gen/design/behaviours.md.

Attackers sit in the first seats of each world and obey the same rules as
everyone: they see only completed batches and published terms, and send one
curve order per batch. Each script is a small state machine: pick a target,
buy for a while, wait, dump, rest.
"""

from __future__ import annotations

import torch

from .params import A_HOARDER, A_NONE, A_PICKER, A_SNIPER, A_WASH, SimConfig

REST, BUY, WAIT, DUMP = 0, 1, 2, 3
BIG = 30_000_000  # more than the hard cap, so intake clips it

#                 none sniper pumper cascade hoarder wash picker
_BUY_BATCHES = (0, 2, 15, 150, 10**9, 0, 0)
_WAIT_BATCHES = (0, 60, 10, 50, 0, 0, 0)
_REST_BATCHES = (0, 0, 100, 100, 0, 0, 0)
_BUY_SIZE = (0, BIG, BIG, 150_000, BIG, 300_000, 0)


class Attackers:
    def __init__(self, n_worlds: int, sim: SimConfig, device: str, gen: torch.Generator):
        self.W, self.A, self.sim, self.dev, self.gen = n_worlds, sim.n_attacker_seats, sim, device, gen
        W, A = self.W, self.A
        if sim.attacker_script >= 0:
            script = torch.full((W, A), sim.attacker_script, dtype=torch.int64, device=device)
        else:
            script = torch.randint(1, 7, (W, A), device=device, generator=gen)
        active = torch.rand(W, A, device=device, generator=gen) < sim.attacker_rate
        # A wash trade needs a partner: seats 0 and 1 wash together or not at all.
        if A >= 2:
            pair = (script[:, 0] == A_WASH) | (script[:, 1] == A_WASH)
            script[:, :2] = torch.where(pair.unsqueeze(1), A_WASH, script[:, :2])
            active[:, 1] = torch.where(pair, active[:, 0], active[:, 1])
        self.script = torch.where(active, script, A_NONE)
        self.phase = torch.zeros(W, A, dtype=torch.int64, device=device)
        self.clock = torch.zeros(W, A, dtype=torch.int64, device=device)
        self.target = torch.zeros(W, A, dtype=torch.int64, device=device)
        self.target_id = torch.zeros(W, A, dtype=torch.int64, device=device)
        self.tab = {
            name: torch.tensor(vals, dtype=torch.int64, device=device)
            for name, vals in (
                ("buy", _BUY_BATCHES),
                ("wait", _WAIT_BATCHES),
                ("rest", _REST_BATCHES),
                ("size", _BUY_SIZE),
            )
        }

    @property
    def scripted(self) -> torch.Tensor:
        """Seats whose orders come from a script (the picker trades as a perfectly informed person)."""
        return (self.script != A_NONE) & (self.script != A_PICKER)

    def orders(self, stage, coin_id, birth, heat, hold_seats, t: int):
        """Return coin [W, A], is_buy [W, A], qty [W, A] (0 = no order) for this batch.

        stage / coin_id / birth / heat are [W, C]; hold_seats is [W, C, A].
        """
        W, A = self.W, self.A
        C = stage.shape[1]
        live = stage > 0
        sc = self.script
        age = t - birth
        gather = lambda x: x.gather(1, self.target)

        # A target that ended or was replaced sends the script back to rest.
        lost = (self.phase != REST) & (~gather(live) | (gather(coin_id) != self.target_id))
        self.phase = torch.where(lost, REST, self.phase)
        self.clock = torch.where(lost, 0, self.clock)

        # Choose a target when rested.
        inf = torch.full((W, C), float("inf"), device=self.dev)
        youngest = torch.where(live, age.float(), inf).argmin(1, keepdim=True).expand(W, A)
        hottest = torch.where(live, -heat, inf).argmin(1, keepdim=True).expand(W, A)
        noise = torch.rand(W, A, C, device=self.dev, generator=self.gen)
        rand_live = torch.where(live.unsqueeze(1), noise, -1.0).argmax(2)
        if A >= 2:
            rand_live[:, 1] = torch.where(sc[:, 0] == A_WASH, rand_live[:, 0], rand_live[:, 1])
        pick = torch.where(sc == A_SNIPER, youngest, torch.where(sc == A_HOARDER, hottest, rand_live))
        fresh = age.gather(1, pick)  # age of the picked coin
        ready = (self.phase == REST) & (self.clock <= 0) & live.gather(1, pick) & self.scripted
        ready &= (sc != A_SNIPER) | (fresh <= 2)
        self.target = torch.where(ready, pick, self.target)
        self.target_id = torch.where(ready, coin_id.gather(1, pick), self.target_id)
        self.phase = torch.where(ready, BUY, self.phase)
        self.clock = torch.where(ready, self.tab["buy"][sc], self.clock)

        held = hold_seats.gather(1, self.target.unsqueeze(1)).squeeze(1)  # [W, A]
        is_wash = sc == A_WASH
        seat = torch.arange(A, device=self.dev).expand(W, A)
        wash_buy = ((t + seat) % 2) == 0
        buying = (self.phase == BUY) & ~is_wash
        dumping = self.phase == DUMP
        washing = (self.phase == BUY) & is_wash
        is_buy = buying | (washing & (wash_buy | (held == 0)))
        qty = torch.where(buying | (washing & is_buy), self.tab["size"][sc], 0)
        qty = torch.where(dumping | (washing & ~is_buy), held, qty)

        # Advance the machine.
        self.clock = self.clock - 1
        to_wait = (self.phase == BUY) & (self.clock <= 0) & ~is_wash
        self.phase = torch.where(to_wait, WAIT, self.phase)
        self.clock = torch.where(to_wait, self.tab["wait"][sc], self.clock)
        to_dump = (self.phase == WAIT) & (self.clock <= 0) & ~to_wait
        self.phase = torch.where(to_dump, DUMP, self.phase)
        done = dumping & (held == 0)
        self.phase = torch.where(done, REST, self.phase)
        self.clock = torch.where(done, self.tab["rest"][sc], self.clock)
        # A wash pair moves to a new coin every 300 batches.
        rewash = washing & (t % 300 == 299)
        self.phase = torch.where(rewash, DUMP, self.phase)
        return self.target, is_buy, torch.where(self.scripted, qty, 0)
