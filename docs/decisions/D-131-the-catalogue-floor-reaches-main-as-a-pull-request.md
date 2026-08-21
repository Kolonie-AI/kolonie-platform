## D-131 — The catalogue floor reaches main as a pull request

**Date:** 2026-08-21

**Problem.** `#1465` settled that the floor is not an author's to edit: `main`
measures the surface after a merge and commits the figure itself. That removed a
real collision — two branches incrementing the same number — and nothing about
the reasoning is wrong. What changed underneath it is that on 2026-08-20 `main`
stopped accepting a direct push, so the actor `#1465` nominated no longer had a
way to write.

The `Commit the floor main measured` step then failed with `GH013` on **every
push to `main` since 07:00 on 2026-08-21** — ten consecutive merges. The floor
froze at 121 tools while `main` served 123.

**It did not fail quietly in the harmless sense.** The floor is a required check,
so a stale figure fails every merge-group build whatever the queued pull request
does. `#1561` entered the queue five times, was evicted four, and spent ninety
minutes failing on two tools somebody else had added. A job that could not write
its own output stopped the queue.

**Decision.** The measured figure travels as a pull request, from a fixed branch
`automation/catalogue-floor`, force-updated so that ten merges produce one pull
request rather than ten. It merges itself through the queue like anything else.

**Rejected: a bypass for a dedicated App or a fine-grained token.** It is fewer
moving parts and it keeps the direct push. It also puts one actor able to write
`main` unreviewed, permanently, so that a number can be committed — which is the
hole the ruleset was put up to close. The queue is the route everything else
takes and the floor is not special enough to be the exception. (The API refuses
the built-in Actions app as a bypass actor, verified 2026-08-21, so that
particular version was not available anyway; the argument does not rest on it.)

**Rejected: stop committing the floor and compute it from `main` at read time.**
The largest of the three, and it re-opens what `#1465` closed. A branch would
have to measure `main`'s catalogue as well as its own, which is a second full
build in every run of `npm run check` — the thing `#1118` split the two entry
points to avoid.

**What it costs, stated rather than discovered.** The floor now lands **one queue
cycle behind** the change that moved it, so a branch opened inside that window is
measured against a number one tool old. That window existed before this decision
and is not widened by it; what makes it survivable is `#1567`, which stops a
merge group being failed for a figure that is not its entry's, and a refusal
message that names _floor trailing `main`_ as one of the two things the
arithmetic can mean.

**Consequences.** A pull request opened with `GITHUB_TOKEN` creates no workflow
runs, so the job dispatches `ci.yml` itself — without that the arrangement is a
pull request that sits for ever, which is a quieter version of the failure it
replaces. The landing message is quoted into the pull request **body** as well as
the commit, because the queue squashes and `check:catalogue-floor` judges the
last commit to touch the file. And `red-on-main.yml` now watches `MCP surface`
beside `CI`, with a standing issue of its own: this failure was invisible for
eleven hours, and that was half of what made it expensive.

Issues: `#1564` (the decision), `#1566` (the route), `#1567` (the queue's side).
