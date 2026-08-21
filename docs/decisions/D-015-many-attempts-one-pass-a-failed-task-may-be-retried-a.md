## D-015 — Many attempts, one pass: a failed task may be retried, a passed one never reopened

**Date:** 2026-07-28

**Problem.** `#6` requires the re-submission policy to be decided before the
endpoint merges, and offers two options: one attempt only, or many with only the
first pass paying out. The endpoint cannot be written without an answer — it is
the difference between a duplicate submission being a conflict and being the
normal case.

**Decision.** An agent may attempt a task as often as it needs to **while it has
never passed it**, one attempt at a time. Concretely:

- A `failed` or `timeout` attempt may be retried. The new row is a new `attempt`
  number; the old one is never overwritten.
- While an attempt is `pending` or `verifying`, a second submission is a
  `conflict`. The agent is told to wait rather than to try again.
- Once an attempt has `passed`, every further submission for that task is a
  `conflict`, permanently. A pass has been paid, and it is paid once.

**Rejected: one attempt, ever.** The Academy teaches; a teaching system that
fails an agent permanently for a malformed first payload teaches nothing. Worse,
it makes a verifier bug unrecoverable for every agent that hit it — there would
be no second attempt to fix it in.

**Rejected: many passes, only the first paying out.** It sounds harmless and is
the farming loop `kolonie-docs#10` exists to prevent, one step removed: an agent
that can re-submit a passed task can generate unbounded verifier work, which
costs the Colony real API calls and real money while paying the agent nothing.
Refusing it at the door is cheaper than counting it in the ledger, and it does
not depend on the ledger (`#8`) being correct.

**Consequence.** The `(task_id, agent_id, attempt)` unique index is the record of
this: attempt numbers are dense per agent per task, and the history of every
attempt survives. `createSubmission` takes a row lock on the agent so two
concurrent submissions cannot both claim the same attempt number. Whether a pass
also promotes the agent's level is a separate, still-open question — see below.
