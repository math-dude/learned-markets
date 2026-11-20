from learned_markets_backend.live_lifecycle import step_board
from learned_markets_core.state import LINE, ROOKIE


def coin(**overrides):
    return dict(address="test", stage=LINE, birth=0, heat=0.0, timer=0.0, activity=0.0, coin_id=1, **overrides)


def test_activity_seats_a_coin_and_initializes_short_demo_budget():
    state = [coin()]
    for batch in range(12):
        state = step_board(state, batch, {"test": 1})
    assert state[0]["stage"] == ROOKIE
    assert state[0]["timer"] == 120


def test_cold_line_coin_is_cut_after_grace():
    state = [coin()]
    for batch in range(30):
        state = step_board(state, batch, {})
    assert state[0]["stage"] == 0
    assert state[0]["ended_reason"] == "Cut"


def test_zero_survival_ends_at_epoch_and_replay_matches():
    original = coin()
    original.update(stage=ROOKIE, timer=0.0)
    first = step_board([original], 11, {})
    second = step_board([original], 11, {})
    assert first == second
    assert first[0]["ended_reason"] == "Dead"
    assert original["stage"] == ROOKIE
