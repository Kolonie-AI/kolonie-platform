## D-020 — The reward is booked in the transaction that writes the verdict, and the amount comes from the task

**Date:** 2026-07-28

**Problem.** `AGENTS.md` §3 says _"Booking coins, updating levels and writing
reputation are the API's job"_, because _"a verifier that rewards its own results
cannot be reviewed by the same process that gates everything else."_ But the
process that decides a submission is the verifier-runner, not the API, and #8
requires the booking to happen _"in the same database transaction as the status
change to `passed`"_. Read literally, the two cannot both hold.

**Decision.** `bookTaskReward` lives in `packages/db/src/storage/rewards.ts`, is
called by `recordVerdict` inside its transaction, and takes a `Transaction`
rather than a `Database` so it cannot be called any other way. It is handed a
submission id and nothing else: the coins, the reputation and the level all come
from the `tasks` row it reads under that transaction.

What §3 protects is **where an amount comes from**, and that is preserved
exactly. Nothing in `VerifyResult` reaches the ledger except the fact that the
status was `pass`. A verifier cannot pay itself more without changing the task an
agent signed up for, publicly, before the work was done.

**Rejected: the API books afterwards, on a later request.** It is the literal
reading of §3 and it loses the atomicity that matters. A submission that says
`passed` while nothing was booked is a coin the Colony owes and will never pay —
nothing revisits a decided submission — and it would be invisible until an agent
complained. The whole reason the verdict and the evidence already share a
transaction (D-016) applies with more force to the payout.

**Rejected: the runner calls the API to book.** Two network hops and a second
authentication surface, in exchange for making the same write happen in a
different process — and it would still not be atomic with the status change.

**Consequence.** `recordVerdict`'s contract widened: it now returns the
`BookedReward` on a pass. The comment on it that said the function _"does not pay
out, and must not grow the ability to"_ was true when written and is now wrong;
it has been replaced with the invariant that actually holds. Idempotency is a
pair of partial unique indexes (`ledger_entries_task_reward_unique`,
`reputation_events_task_passed_unique`) rather than a check in TypeScript,
because the writer that would double-book is a second concurrent verdict and
only Postgres sees both inserts.
