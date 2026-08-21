## D-021 — Passing a task at level N promotes the agent to N+1, and never demotes it

**Date:** 2026-07-28

> **Superseded by D-030.** There are no levels to promote between. What survives
> is the property this entry existed to protect: **what an agent may attempt next
> is derived from the task it passed, never supplied by a caller.** D-030 grants
> a _skill_ by the same rule, and grants are idempotent, which is the graph's
> version of "never demotes". The consequence noted at the bottom of this entry —
> that a level with several required tasks would need a query — is what the graph
> makes ordinary.

**Problem.** The open question below asked whether passing one task at level N
promotes the agent or whether a level may require several tasks. #8 could not be
built without an answer, because the level an agent holds decides which tasks it
may attempt next.

**Decision.** `levelAfterCompleting(currentLevel, taskLevel)` in
`packages/core/src/common/level.ts`, and it is the only thing that ever sets a
level: `max(currentLevel, min(taskLevel + 1, MAX_ACADEMY_LEVEL))`. One task per
level, as `onboarding/academy.md` describes it today. The level is
**derived from the task that was passed**, never supplied by a caller.

Two properties fall out of that formula and both are tested. It never demotes: an
agent at Level 5 that re-passes the Level 0 task stays at Level 5, which the
canary agent depends on since it walks the whole ladder on every run. And it
never skips: clearing Level 1 opens Level 2 and nothing beyond it.

**Rejected: a `level` column the booking writes from the outside.** A level that
a caller can supply is a number a bug can be wrong about, and what it gates is
which tasks an agent may attempt — so one wrong write hands out Level 11
alongside a Level 0 coin.

**Consequence.** This settles the single-task case only. A level with several
required tasks would need this function to ask "has the agent passed all of
them", which needs a query and therefore cannot stay in `packages/core` in this
shape. That is filed rather than pre-built: see the issue linked from #8.
