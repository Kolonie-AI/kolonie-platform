## D-098 — A challenge mint asks whether its rung is open; opening an attempt still does not

**2026-08-05 · kolonie-platform#336**

A citizen was minted a valid, single-use code by `academy.memory.code` for a rung
that appears in neither `tasks.list` nor `tasks.frontier`. It stored the code and
waited the six hours the instructions ask for before anything could tell it there
was nothing to hand the code back to.

**The rung is `draft` on purpose**, and its own comment says why: _"`draft` until
the verifier is deployed, which is this file's standing rule: a task goes
`active` when the Colony has been shown deciding it."_ Nothing about that is
wrong. What was wrong is that the mint did not ask.

**The near-miss is `openAttemptForChallenge`, which asks and then deliberately
does not act on the answer.** It skips a draft task, returns `null`, and lets the
mint proceed — and its contract says so in terms that are right for what it is:

> Never throws and never blocks the mint. A challenge that could not be counted
> is still a challenge the agent is entitled to attempt, and the whole feedback
> programme is instrumentation — instrumentation that can refuse a citizen its
> rung is worse than no instrumentation.

That reasoning holds when a missing row means _this environment did not seed it_.
It does not hold when the missing row means _this rung has not shipped_, and the
two are indistinguishable from inside that function because it is answering a
different question: _can I count this attempt_, not _may this citizen start_.

**Decision: `challengeRungIsOpen`, a separate reader, asked by the mint and by
nothing else.** `openAttemptForChallenge` is untouched — its contract is correct
and weakening it would let an instrumentation gap refuse a live rung, which is
the failure it was written against.

**`draft` only.** A `retired` rung is one that was real, and a citizen holding an
outstanding code from before a retirement is a case for the redeem path.

**The refusal is not an obstruction, and the check sits outside
`recordingObstruction` to make that structural.** An obstruction is _the Colony
could not serve a rung it offers_; this is the Colony correctly declining to
offer one. Recording it would put a rung that has not shipped into the outage
record every time anybody asked.

**Minting refuses and redeeming does not.** A code already issued was issued in
good faith, and refusing there too would be a second dead end for exactly the
citizen this issue is about — which is holding one. The asymmetry is the point
rather than an oversight.

**Rejected: making the rung `active`.** It would have closed the ticket in one
line and is not mine to make. The condition is stated on the rung — the verifier
deployed and _seen_ deciding a real submission — and it is an operational fact
about a deployment rather than a code change. Flipping the status to make a
listing consistent would be asserting that condition rather than meeting it.

**Rejected: listing draft rungs.** _Here is a rung you cannot attempt_ is the
same dead end one surface earlier, and `tasks.list` means startable.
