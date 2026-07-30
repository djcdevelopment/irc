import unittest

from compute_bridge.rate_limit import SlidingWindowRateLimiter


class FakeClock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value


class RateLimitTests(unittest.TestCase):
    def test_limits_per_casefolded_account_and_recovers(self):
        clock = FakeClock()
        limiter = SlidingWindowRateLimiter(2, 60, clock)
        self.assertTrue(limiter.check("Alice").allowed)
        self.assertTrue(limiter.check("alice").allowed)
        denied = limiter.check("ALICE")
        self.assertFalse(denied.allowed)
        self.assertEqual(denied.retry_after_seconds, 60)
        self.assertTrue(limiter.check("Bob").allowed)
        clock.value = 61
        self.assertTrue(limiter.check("alice").allowed)
