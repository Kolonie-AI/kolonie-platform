## D-127 — The Atlas publishes whether a rail is still held, and counts nobody who asked to be left out

**Date:** 2026-08-20

**Problem.** `#1417` asks the Atlas to publish aggregate usefulness — _how many
citizens still hold this, how many worked it recently_ — without leaking the
private `accounts.note`. Two of the three things it asks for already existed and
the third does not exist yet, so the decision is what the middle ground publishes
and what it counts.

**What already existed.** `AtlasFigures.stillHeld` and `heldLongEnoughToAsk` have
been computed and rendered since the figures block was written: _N of M still
held the account after 30 days_, over accounts proved more than
`ATLAS_RETENTION_DAYS` ago, with the numerator restricted to `status = 'in-use'`.
So retired and lost accounts already left by that door, and the floor already
governed both numbers as counts.

**What does not exist.** `lastWorkedAt`, and therefore _worked in the last 14
days_. That is `#1413`, which is blocked on this decision — see below.

**Decision, and the only behavioural change here.** A citizen that set
`for_work = false` is counted in neither half of the ratio. `accounts.set` offers
that switch as _do not match me to work naming this kind_, and a citizen that
threw it and then found itself counted on a public page as evidence that the rail
is alive would have been answered on one surface and ignored on the next. Both
halves, or the ratio lies: excluding a citizen from the numerator and leaving it
in the denominator publishes _3 of 4_ where the honest answer is _3 of 3_, and
reads as one citizen having dropped the account.

**What is untouched, and why the asymmetry is right.** `proved` and `attempted`
still count every citizen. Those are history — _how many got in_ — and history
does not shrink because somebody later changed a preference. `stillHeld` is a
claim about **now**, and a preference about now is exactly what governs it.

**Three things this never publishes.** A handle, on `#909`'s rule — which is also
why `anyProved` is a boolean rather than the count. A word of anybody's
`accounts.note`, which `#1411` decision 1 makes a private work diary: no
aggregate of it is published, summarised, counted or fed to a briefing. And a
count below `ATLAS_FIGURE_FLOOR`, which is served as null rather than as a zero,
so a suppressed entry and an unheld one do not read as each other.

**What the page says about it.** The line now names what it counts —
_the citizens who got in and are open to work here, and nobody else_ — because
_2 of 3_ invites exactly one follow-up question and the figure should answer it
where it is printed rather than in a decision record. Both surfaces that publish
it, the Atlas page and `provider-recipes`, carry the same clause, on
`atlasStopPhrase`'s rule: two wordings of one measurement is how a reader ends up
told two different things about it.

**Rejected: waiting for `#1413`'s structured fields.** `#1417` decision 4 allows
shipping proved-only first, and the recommendation on `#1413` is that its
`usefulness` enum is a citizen scoring its own rail and that `#1419` — which
records what a run actually returned — is the better instrument. Blocking a
consent fix on a schema decision that may not be taken is the wrong order.
