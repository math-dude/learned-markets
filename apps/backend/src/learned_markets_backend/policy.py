"""Public-observation policy boundary shared with training-owned policy adapters."""

from collections.abc import Callable

import torch
from learned_markets_core.quoter import build_quote, rule_based_params
from learned_markets_core.state import LINE, REGULAR, ROOKIE, MarketConfig, MarketState

from .contracts import Observation, PublicMarket, Quote

WINDOW = 16
STAGES = {"Line": LINE, "Rookie": ROOKIE, "Regular": REGULAR}
Policy = Callable[[Observation], Quote]


def state_for(market: PublicMarket, people: int = 1):
    cfg = MarketConfig(n_worlds=1, n_slots=1, n_people=people, window=WINDOW)
    state = MarketState.empty(cfg)
    state.tick[0, 0] = market.tick
    state.stage[0, 0] = STAGES[market.stage]
    state.q_cash[0, 0] = market.reserve_cash
    state.q_tokens[0, 0] = market.reserve_tokens
    state.timer[0, 0] = market.timer
    state.t = market.batch_id
    return state, cfg


def rule_quote(obs: Observation) -> Quote:
    state, cfg = state_for(obs.market)
    params = rule_based_params(state, torch.tensor([[obs.previous_imbalance]]), cfg)
    quote = build_quote(state, params, cfg)
    return Quote(
        centre_tick=obs.market.tick,
        bid=quote.bid[0].tolist(),
        ask=quote.ask[0].tolist(),
        cap_share=float(quote.cap_share[0, 0]),
        fee0=float(quote.fee0[0, 0]),
        half_life=float(quote.half_life[0, 0]),
        slope=float(quote.slope[0, 0]),
    )
