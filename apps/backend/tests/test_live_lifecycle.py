from learned_markets_backend.live_lifecycle import close_split, rank_survivors, step_board
from learned_markets_core.state import LINE, REGULAR, ROOKIE


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


def test_close_split_matches_program_and_conserves():
    assert close_split(1000, 0) == (0, 0, 1000)
    assert close_split(50, 3) == (10, 3, 11)
    for total in (0, 1, 99, 10**9 + 7):
        for n in range(1, 9):
            each, dep, platform = close_split(total, n)
            assert (each + dep) * n + platform == total


def test_rank_survivors_prefers_stage_then_activity_and_skips_closing_and_dead():
    coins = [
        {"address": "a", "stage": LINE, "activity": 9.0, "heat": 0.0},
        {"address": "b", "stage": REGULAR, "activity": 1.0, "heat": 0.0},
        {"address": "c", "stage": ROOKIE, "activity": 5.0, "heat": 0.0},
        {"address": "d", "stage": 0, "activity": 50.0, "heat": 0.0},
        {"address": "e", "stage": REGULAR, "activity": 3.0, "heat": 0.0},
    ]
    assert [c["address"] for c in rank_survivors(coins, "e")] == ["b", "c", "a"]
