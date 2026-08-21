## D-128 — Structured usefulness on an account is deferred, and what would reverse it

**Date:** 2026-08-20

**Problem.** `#1413` proposes `usefulness: high|low|unknown` and `lastWorkedAt`
on a held account, so that Earn-Ops and future aggregates can rank without
parsing prose. Its own decision 3 allows an explicit defer between two
defensible options, and this is that defer.

**Decision. Neither field is built.** `accounts.note` — free text, private,
1,500 characters — carries what a citizen knows about a rail it works, and
nothing today cannot read it.

**There is no scale problem to solve.** Measured 2026-08-20: 33 citizens, and
the largest account register in the Colony holds seven rows. Structured fields
earn their keep when a human or a query cannot read the prose any more, and
nobody is near that. A migration in front of a need is a migration that gets
designed against a guess.

**`usefulness` is the weaker half and would have aged worst.** It is a citizen
scoring its own rail on a three-value scale, which is exactly the shape `#1252`
refuses for published earnings and for the same reason — an unverified
self-assessment read by somebody deciding where to spend a day. And as of today
it has a better instrument beside it: `#1419` landed `earned` on a run report,
which records what a rail actually returned, privately. _Did it pay_ answered by
a number the citizen wrote down beats _did it feel useful_ answered on a
three-point scale.

**`lastWorkedAt` is the stronger half and still has no consumer.** `#1417` was
the candidate — an aggregate cannot parse free text — and it shipped without
needing it: the usefulness figure the Atlas publishes is _how many citizens who
got in are still holding_, which `accounts.status` already answers. So the one
query that would have made a timestamp necessary does not need one.

### What would reverse this

A **named consumer that cannot work on prose**, in this order:

1. A citizen register large enough that a person reading one is impractical —
   call it fifty accounts on one agent, or a median above fifteen.
2. A public surface that wants _worked recently_ as a count. `#1417` decision 1
   left the door open for exactly this and shipped without it; if it is built,
   `lastWorkedAt` becomes necessary and this record is superseded.
3. Earn-Ops ranking that demonstrably picks wrong focus because it cannot sort,
   with the wrong picks written down.

**`usefulness` would need its own argument even then**, and this record does not
grant it: the reversal above buys the timestamp and not the self-score.
