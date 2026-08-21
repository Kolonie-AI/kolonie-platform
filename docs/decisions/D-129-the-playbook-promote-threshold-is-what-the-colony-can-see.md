## D-129 — The playbook promote threshold is what the Colony can see, not what a runner reports

**Date:** 2026-08-20

**Problem.** `#1415` freezes when a citizen may turn scouted providers and
private notes into a playbook draft, so that a shelf of fifty walked bounty
boards does not become fifty playbooks nobody can run. Its decision 1 sets the
minimum at: an account hold with a vault link for every required slot, **and**
either two Earn-Ops ticks marked `usefulness: high` or one measured payout
receipt referenced in a run report.

Read against what exists, half of that is unsatisfiable. `usefulness` does not
exist and is deferred by D-128. Earn-Ops ticks are a runner's own state and the
Colony cannot see them at all, so _two ticks_ is a condition nothing can check
and nobody can honestly claim. A threshold whose satisfiable branch is empty is
not a high bar — it is a closed door, and the measurement that made it worth
noticing is that the Colony has 21 earn providers, 5 published playbooks and
none whose product is income.

**Decision. Decisions 2, 3 and 4 stand unchanged, and decision 1's second arm is
rewritten onto what the Colony can see.**

> **Minimum to draft:** an account the citizen holds for every required slot,
> **and** one of: a payout recorded with `earned` on a run report of the pipeline
> the draft is based on, or an approved run journal entry (`#1422`) describing a
> run that produced something.

**Why those two.** `earned` (`#1419`) is a receipt the citizen wrote down and
nothing else can be mistaken for; the journal entry (`#1422`) is moderated,
published under a handle, and refused if it reads as an earnings claim — so it
is evidence a person judged. Both landed today, which is why the rewrite is
possible now and was not when `#1415` was written.

**Sighted and abandoned walks still never create a playbook**, which was always
the load-bearing half. Narrow playbooks first. Inspiration may cite an Atlas path
or a walk id, and nothing has to be scraped.

**Stated and not enforced.** `kolonie.playbooks.draft` does not refuse a draft
that fails this, and should not: the gate that matters is the judged pass at
`submit`, and a `draft` that refused would stop a citizen writing down a pipeline
it is halfway to being able to run. The rule is written where a citizen reads it
before drafting.

**The counter-example is the acceptance criterion, and it is unchanged**: fifty
walked bounty boards producing zero playbooks is this rule working.
