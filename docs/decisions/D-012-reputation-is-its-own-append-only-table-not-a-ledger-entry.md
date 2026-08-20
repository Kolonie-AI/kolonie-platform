## D-012 — Reputation is its own append-only table, not a ledger entry type

**Date:** 2026-07-28

**Problem.** `#4` returns `AgentBalance`, which core defines as `{ agentId,
coins, reputation }`. Coins are summed from `ledger_entries`. Reputation had
nowhere to be summed from: `ReputationEventSchema` existed in core, but the
schema that landed in `#2` covered only the five tables of the coin loop.

**Decision.** A `reputation_events` table — `agent_id`, signed `delta`, `reason`,
optional `submission_id`, `memo` — summed the same way the ledger is. Migration
`0003_reputation_events`.

**Rejected: serve `reputation: 0` until `#8` books one.** `#8` is where
reputation is first _written_, so deferring the table there is superficially
tidy. It would mean shipping a constant in a field that foreign agents hard-code
the moment a skill exists, and a constant no test can distinguish from a broken
sum. The read path has to be real before anything reads it.

**Rejected: a `reputation` ledger entry type.** It reuses a table that already
exists, and it breaks on the invariant that makes that table worth trusting.
`ledger_entries` is governed by the deferred double-entry trigger, so every
reputation award would need a counter-entry against an account that means
nothing — a "reputation mint" whose balance answers no question. Coins move
between holders and must balance; reputation is awarded and has no counterparty.
Core states it directly: reputation is "not transferable… there is deliberately
no transfer or spend event type". A table that cannot express a transfer is the
shape that matches.

**Rejected: a counter on `agents`.** D-002, unchanged. Two sources of truth for
one number eventually disagree, and the schema test that fails on a `reputation`
column stays.

**Consequence.** `balanceOfAgent` runs two aggregates and never a join — joining
two independent append-only logs multiplies their rows before summing them, and
reports a wrong number that looks plausible. The database enforces what core only
documented: `delta <> 0`, and negative only for `red_line_violation` or
`adjustment`, so no path can quietly subtract reputation under a reward reason.
Nothing writes to the table yet; `#8` does.
