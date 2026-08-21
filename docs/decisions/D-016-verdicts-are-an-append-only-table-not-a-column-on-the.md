## D-016 — Verdicts are an append-only table, not a column on the submission

**Date:** 2026-07-28

**Problem.** `#7` requires that `evidence` is persisted on every verdict, pass
and fail alike, because it is the audit trail behind every coin the ledger will
ever book. The schema had nowhere to put it. Two obvious places: an `evidence`
column (plus the verifier's status and metadata) on `submissions`, or a table of
its own.

**Decision.** A `verifications` table, append-only, one row per check.

**Rejected: columns on `submissions`.** They are cheaper and would have worked
until the first verifier that answers `pending`. That verdict — "the transaction
has not confirmed yet" — is legitimate and returns the submission to the queue,
so a submission is checked as often as the outside world needs. With a column,
each check overwrites the last, and the record of a passed submission reads only
as far back as the check that passed it. The Colony would then be unable to say
_why_ a payout took the time it did, or that the earlier checks happened at all.

The same argument the ledger makes about balances (D-002) and reputation makes
about events (D-012): the log is the truth, and a field that is rewritten is not
a log.

**Consequence.** `submissions.status` says where a submission stands;
`verifications` says how it got there, and `#8` books against the last row of it.
The runner writes a row for every verdict — including a `timeout` written by the
sweep — and writes nothing at all when it skips a submission, because a skip is
the absence of a check rather than a verdict about the agent. `metadata` stays
`null` rather than `{}` when a verifier offered no proof: "no proof" and "empty
proof" are different statements about a payout.
