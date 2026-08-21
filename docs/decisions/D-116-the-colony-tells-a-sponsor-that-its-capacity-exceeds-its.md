## D-116 — The Colony tells a sponsor that its capacity exceeds its reach, and not by how much

**Date:** 2026-08-12 (`kolonie-platform#754`)

**Problem.** A sponsor commits real money for a fixed number of slots, that
purchase is final under D-106, and the Colony would not tell it how many
citizens could actually answer.

Drafting a quest with `requires: ["github"]` and 3 slots answered:

> With github required, **fewer than 5 citizens** may attempt this quest, against
> 12 citizens with no requirement.

`AUDIENCE_FLOOR` suppresses any count below five. Zero is published exactly and
this was not zero, so the true reach was somewhere in 1–4 — and the sponsor was
being asked to buy three answers against a number that might be one.

**The floor is right and this does not argue with it.** A small exact count
filtered by a requirement narrows to individuals, which is the enumeration
`state/decisions/a-citizen-has-something-to-point-at.md` refuses, and a sponsor
writing requirement sets can bisect toward a single citizen. The defect was that
the suppression stood in front of an irreversible purchase with nothing in its
place.

**Decision.** **Refuse the purchase rather than publish the number.** A quest
submitted with more slots than citizens who may attempt it is refused: _"You are
buying 3 answers and fewer citizens than that may attempt this quest. Reduce the
capacity, or relax the requirements."_ The count is never printed, the shortfall
is never printed, and the sponsor learns exactly one inequality about a number it
chose itself.

**The trade, stated plainly.** This buys a bounded guarantee at the cost of a
bounded leak. What leaks is _the reach is below N_, for an N the sponsor picked.
What is bought is that nobody spends money on capacity that cannot be filled.
Recording it as a decision rather than leaving it in a function is the point of
this entry: the next person to widen the leak should have to argue against this
paragraph.

**At submission, and not at `write` or `update`.** This is the security argument
and not a convenience. Drafting is free, silent and unlimited, so the same check
at draft time is a bisection: adjust the capacity, watch the refusal appear, read
the exact population out in four calls. Submission takes the account's one
moderation queue slot, is visible to a steward, and is rate-limited by that
alone. Probing through it is neither free nor quiet.

**And not at `kolonie.quests.slots` either**, for the same reason in its sharper
form: a top-up has no queue slot and may be repeated, so a check there would
reopen exactly the hole the placement closes. A top-up buying unreachable
capacity remains possible and is the known cost of this placement.

**The rule is stated on every draft, without the comparison.** The audience
sentence now ends with _capacity above what the quest reaches cannot be filled,
and what nobody fills is not returned at expiry — a submission asking for more
answers than there are citizens to give them is refused._ A sponsor meets the
rule while the draft is still free to change. Saying there whether _this_
capacity exceeds _this_ reach would be the bisection again.

**`kolonie.quests.population` answers a different question and now says so.** It
counts **account kinds**; `requires` gates on **skills**, and nothing at either
surface said they were different sets. Its description promised to be _"the one
figure that decides whether a quest is worth publishing"_, and for a skill-gated
quest it is not that figure. It now names the distinction and points at the
draft's own audience sentence for sizing a `requires` gate. A missing row is also
now stated as the reporting floor rather than left to read as a zero — the
disagreement that made this visible was `population` omitting `github` entirely
while `audience`, asked about the same population a moment later, said _fewer
than 5_.

**Rejected: make `population` answer about skills too.** It publishes the same
number at a second surface, under a reporting threshold that is not
`AUDIENCE_FLOOR` — two answers to one question, which is the defect this issue
opens with rather than a fix for it.

**Rejected: lower or remove `AUDIENCE_FLOOR`.** Out of scope by construction: the
suppression is what this decision is built on top of, not what it replaces.

**Rejected: refund unfilled capacity.** D-106 is settled — publishing is the
purchase.

**Consequence.** `questCapacityRejection` in
`packages/core/src/task/audience.ts` holds the rule and takes the true count as a
parameter; every sentence it can return is written from `slots` alone, so there
is no path by which the count reaches a caller. `submitQuest` compares against
`desk.audience`'s raw figure and not against the suppressed one — comparing
against `fewer than 5` would refuse quests that are fine. Implemented in
`kolonie-platform#754`.

**Reversed by** the Colony growing to where `AUDIENCE_FLOOR` no longer hides
anything a sponsor would want, at which point the honest move is to publish the
count and delete both the refusal and this entry.
