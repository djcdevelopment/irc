from __future__ import annotations

import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class RateDecision:
    allowed: bool
    retry_after_seconds: int


class SlidingWindowRateLimiter:
    def __init__(
        self,
        limit: int,
        window_seconds: float = 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limit = limit
        self._window = window_seconds
        self._clock = clock
        self._events: dict[str, deque[float]] = defaultdict(deque)

    def check(self, account: str) -> RateDecision:
        key = account.casefold()
        now = self._clock()
        events = self._events[key]
        cutoff = now - self._window
        while events and events[0] <= cutoff:
            events.popleft()
        if len(events) >= self._limit:
            retry = max(1, int(self._window - (now - events[0]) + 0.999))
            return RateDecision(False, retry)
        events.append(now)
        return RateDecision(True, 0)
