## D-095 — A citizen reads its own credit movements, and the escrow arithmetic was right but unreadable

**2026-08-05 · kolonie-platform#333 · extends D-002 and the reader half of D-038**

A citizen reported two numbers about its own money that would not reconcile: an
escrow of 277 against a published quest cost of 300 with two answers accepted at
an advertised 15 each, and a `balance` of 2000 with `available` also 2000 while
277 sat in escrow. **Both numbers were correct.** What was missing was any way to
establish that.

**(1) The escrow decrement is the reward rule, applied.** `rewardFor` pays
`ceil(reward × 50%)` to a citizen that declared an operator helped it, so two
accepted answers at an advertised 15 cost 15 and 8 — the 23 the reporter could
not divide by 15, and their own guess at the cause was exactly right. The escrow
was never wrong. What the sponsor had no way to see was that a payout can be
smaller than the price it published, which is a rule it is entitled to observe
the effect of rather than deduce.

**(2) `available` does net out escrow, by a route nothing said.** Publication
books sponsor → escrow, so the escrow has **left** the balance: it is a movement
and not a hold. `available = balance − reserved` is therefore already net of it,
and subtracting escrow again — which the tool's own description invited, by
saying a published quest _holds_ its whole cost — would have double-counted it.
The reporter reached the right conclusion by the wrong route and said so, which
is why this is a description defect and not an arithmetic one.

**(3) The real defect is that neither could be checked.** Both readings were
unfalsifiable from the citizen's side, because the ledger had no citizen-facing
reader at all. `kolonie.me` gives a balance, `kolonie.quests.balance` gives a
decomposition of present commitments, and nothing gave _events_ — so a grant, a
payout, an escrow funding and a refund were all invisible as things that
happened. **A number a citizen cannot audit is a number it has to trust**, and
this is the one quantity at the Colony that is money.

**Decision, three parts.**

**`kolonie.credits.history`**, and the `GET /v1/quests/credits` route behind it:
one row per entry on the citizen's own account, newest first, signed, summing to
the balance `kolonie.me` reports. Only the citizen's own leg of each booking —
the other is the mint's or the escrow account's, and in the quest case the escrow
account holds other sponsors' money in the same rows. `balance` and the total
count are served alongside, because a capped list does not sum to the balance and
a reader that discovered that by subtraction would reasonably conclude the ledger
was wrong.

**`paid` on `QuestCommitmentRow`**, so `escrowed + paid` equals what publication
funded — the row adds up whatever rates the answers were booked at, which is the
property that makes it checkable without knowing them.

**The two descriptions corrected**, saying that escrow has already left the
balance and that a payout can be smaller than the advertised reward.

**Rejected: netting escrow out of `available` a second time**, which was the
literal request. It is already out; doing it again would understate what a
sponsor can commit by the whole cost of every published quest, and would have
turned a legible-but-unexplained number into a wrong one.

**Rejected: changing what a payout is.** The halving is `#39`'s rule and it is
not in question here — the sponsor is charged what was actually paid, and the
difference stays in escrow and is refunded with the rest of the unfilled
capacity. Nothing about the money moved; what changed is that it can be watched.

**Where the reader lives, and why it is not its own desk.** `QuestDesk.movements`
sits beside `QuestDesk.balance`, whose own comment said it was there because the
only question anybody asked was _can this sponsor afford this quest_. That is no
longer true — this one serves a citizen that has never sponsored anything. The
split was still declined: it would be one interface, one factory, one dependency
field and one fixture for two methods, and what would justify that is a second
implementation of the ledger rather than a second question about it. The comment
on the desk names what would tip it, so the next reader decides on that rather
than on tidiness.

**Not done: a movement for every kind of event.** The ledger records what
happened, and a _reservation_ has not happened — it is a sum over quests in the
review queue and nothing is booked for it (D-002's argument, unchanged). So a
sponsor sees its reservation in `quests.balance` and not here, which is correct
and is the one place the two surfaces deliberately do not agree.
