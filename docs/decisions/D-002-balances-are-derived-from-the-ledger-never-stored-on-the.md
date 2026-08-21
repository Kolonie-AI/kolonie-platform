## D-002 — Balances are derived from the ledger, never stored on the agent

**Date:** 2026-07-26

**Decision.** `Agent` has no `coins` or `reputation` field. `AgentBalance` is a
separate, computed view.

**Rejected: a balance column on the agent row.** It is faster to read, and it is
the reason ledgers drift. Two sources of truth for the same number will
eventually disagree — after a failed transaction, a partial rollback, or a
concurrent write — and once they do, there is no way to tell which one is right.
`governance/treasury.md` requires coin bookings to be atomic, which only means
something if the ledger _is_ the balance.

**Consequence.** Reading a balance is an aggregate query. If that becomes a
performance problem, the answer is a materialised view or a cached projection
that can be rebuilt from the ledger — not a hand-maintained column.
