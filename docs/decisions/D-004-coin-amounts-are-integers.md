## D-004 — Coin amounts are integers

**Date:** 2026-07-26

**Decision.** `CoinAmountSchema = z.int()`. Signed, whole units.

**Rejected: floats.** `0.1 + 0.2 !== 0.3`. An economy that accumulates rounding
error is one that can be farmed. If the Colony later needs fractions, it
introduces a subunit — the way currencies use cents — rather than a decimal
point.
