## D-121 — The database client does not reattempt a statement, and `CONNECTION_ENDED` is not the error it sounds like

**2026-08-14 · kolonie-platform#874 · raised out of #871**

**The answer is no**, and the reason is not the one the question anticipated.

`#874` asked whether `packages/db`'s client should retry once when the connection
ended before a statement ran, reasoning from the error's name: _"`CONNECTION_ENDED`
is precisely the error where a retry is safe in principle — the statement did not
execute, so there is nothing to duplicate."_ The first half is right. The second
does not follow, because the name means something narrower than it reads.

**In `postgres`, `CONNECTION_ENDED` is raised in exactly one place**: the query
handler's first line, when the pool is `ending`, which is what `sql.end()` sets.
It is not _the socket died under a live statement_. It is **this pool has been
shut down** — and that is terminal. Measured against the real driver
(`packages/db/src/connection-ended.test.ts`, 2026-08-14): a query on an ending
pool gets `CONNECTION_ENDED`, the retry gets `CONNECTION_ENDED`, and one long
afterwards gets `CONNECTION_ENDED`. **A retry does not have a smaller chance of
succeeding. It has none.**

**Both incidents `#874` measured are that case.** `closeShare` on 2026-08-13 and
the credential read behind `kolonie.tasks.note` on 2026-08-11 both carried
`write CONNECTION_ENDED postgres:5432`, which is the message `Errors.connection`
builds for it. A pool that is ending is a process that is shutting down, so the
proposed retry would have failed identically, twice, a millisecond later. **The
feature would have bought nothing measurable and added a code path exercised only
during shutdown** — the worst place to have one, because it runs when nothing is
watching and every test around it is green.

**The error that does mean what the question described is `CONNECTION_CLOSED`,
and it is the worst candidate of the three.** It is raised when the socket closes
with queries already _sent_ — so it is exactly the case where the driver cannot
say whether the statement reached the server. A retry rule would be unsafe for
writes precisely where it would be useful, which is the risk `#874` named and
priced correctly.

**And the code is not on the error a caller catches.** Drizzle wraps it as
`Failed query: …` and puts the original on `cause`, so a rule written against
`error.code` — the shape `#874`'s first question invites — matches nothing and
silently never retries. That is the quiet failure this decision would most likely
have shipped with, and it is pinned by a test rather than left in prose.

**What stays.** `#871`'s narrow local answer: one retry, in the one place where
the function is already idempotent by construction and says so. A local retry
argued at its own call site is a different thing from a policy applied to every
write the Colony makes.

**Consequence.** No change to `packages/db/src/client.ts`.
`connection-ended.test.ts` holds the measurement, executable rather than quoted,
because the claim is about somebody else's library and a claim like that goes
stale without anybody editing it.

**Reversed by** `CONNECTION_CLOSED` appearing in Loki at a rate that costs
citizens something — that is the error a retry could actually address, and it
would have to be argued on whether the driver's _did not execute_ guarantee is
strong enough to trust with every write. It has not appeared yet: what has, twice
in a week to 2026-08-13, is a shutting-down pool.
