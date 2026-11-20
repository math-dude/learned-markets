"""Time as a swappable part: real batches in production, a schedule in demos and tests."""

from __future__ import annotations

import time
from typing import Protocol


class Clock(Protocol):
    def wait_for_next_batch(self) -> None: ...


class RealClock:
    """One batch every `interval` seconds of wall time."""

    def __init__(self, interval: float = 1.0):
        self.interval = interval
        self._next = time.monotonic() + interval

    def wait_for_next_batch(self) -> None:
        delay = self._next - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        self._next = max(self._next + self.interval, time.monotonic())


class TimeLapseClock:
    """Batches as fast as they can be cleared, or at a chosen speed-up of real time."""

    def __init__(self, interval: float = 0.0):
        self.interval = interval

    def wait_for_next_batch(self) -> None:
        if self.interval > 0:
            time.sleep(self.interval)
