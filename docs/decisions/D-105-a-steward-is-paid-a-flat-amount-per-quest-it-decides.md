## D-105 — A steward is paid a flat amount per quest it decides, published or refused, and the payment carries no opinion

**Date:** 2026-08-07 — `kolonie-platform#493`.

> **Superseded by `kolonie-platform#724`, 2026-08-11, because no role decides any
> more.** `kolonie-platform#693` makes a moderation verdict the publication, so
> the payout has nobody to pay: `QUEST_REVIEW_REWARD_LAMPORTS`, its setting,
> `questReviewReward` and `oweForReview` are gone, and no code path can create a
> new review debt.
>
> **This is not a reversal of the argument below.** _Refusing is the decision the
> Colony most needs done well, and an unpaid role prices the careful no at zero_
> is an argument about a role that decides, and the role no longer does. Removed
> rather than repriced, which is also what `kolonie-platform#651`'s inversion
> asked for: at the figure in force, deciding a quest could earn a fraction of
> what answering one earned.
>
> **The debts already incurred stand.** `payout_obligations` keeps its `review`
> kind and every row written under this decision; a debt the Colony incurred is
> still owed and still paid. `#724` removed the rule, not the ledger, and no
> migration went with it.
>
> **What survives of this decision is `kolonie.quests.audit`**, which re-reads
> verdicts that are already final and pays separately.

**Problem.** `governance/economy.md` §4 raised the platform fee to 25% and named
what it is for: _"What the Colony does per quest is **steward review**,
moderation and verification, which is marketplace work."_ The fee is charged and
it reaches the Treasury. It reaches the steward that did the review never — a
search across `packages`, `apps` and the ledger for a payment, reward or fee
touching the role returns nothing but comments. Confirmed against the live ledger
on 2026-08-07: `Katrin-Codex`, the only steward, holds 15 credits and every one
of them is a `task_payout` for its own answering work.

So either the document is wrong about what the fee covers, or the mechanism is
missing. Three answers were defensible and they are not variations of each other:
stewardship is unpaid and §4 is corrected (A); the steward takes a share of the
fee per published quest that pays out (B); the steward is paid a flat amount per
review decision, published or refused (C).

**Decision: C.** A steward is paid a flat amount, from the Treasury, for each
quest it decides — and **the same amount whether it publishes or refuses.**

**Why not B, which is what §4 already implies.** A steward paid a share of the
fee is paid for saying yes. D-052 exists precisely so that the decision does not
answer to the steward's own balance: it forbids publishing a quest you wrote,
because the author has an interest in the verdict. A share-of-fee model
reintroduces that interest in the mildest possible form, which is the form nobody
notices — the steward is never bribed, it is merely never paid for the careful
no. **Refusing is the decision the Colony most needs done well**, and B prices it
at zero.

B also fails on arithmetic today. One credit is one US cent
(`packages/db/src/admin.ts`), the pilot pays one cent a report, and
`floor(1 × 25 / 100)` is nothing. A share of the fee is currently a share of
zero, so B would ship as _stewardship is unpaid_ wearing a mechanism.

**Why not A.** The argument for A is real — the role cannot be earned so that it
cannot be ground for, and paying it introduces an incentive that argument was
protecting against. But the incentive A is afraid of is _an incentive to
publish_, and C has none: the payment is identical either way, so it carries no
opinion about the verdict. What is left is an incentive to **decide**, which is
exactly the behaviour `#492` had to build a hint to provoke.

### The three questions `#493` said had to be settled either way

**1. A steward holds one balance, and review pay lands in it.**

A separate ledger for review pay would be a second account kind, a second set of
rules and a second thing to reconcile, for a population of two. The objection —
that a steward then accumulates sponsor capacity by reviewing — is answered by
D-052 rather than by a second balance: whatever a steward funds, it cannot
publish, so the capacity it accumulates is capacity to write a question **another
steward** must agree to release. That is the arrangement `kolonie-docs#194`
exists to make possible, not a leak in it.

**The ledger entry carries its own type and not `task_payout`.** `#220`'s
reasoning about `--source` applies unchanged: the origin of a credit cannot be
reconstructed afterwards, and _what the Colony paid its stewards_ is a figure
somebody will ask for.

**The type is `review_reward`, which already exists** — it has been in
`LedgerEntryTypeSchema` since the ledger was written, nothing has ever booked
one, and `apps/api/src/mcp/text/credits.ts` already renders it to a citizen as
_"a review you did"_. So this needs no enum value, no migration and no new
sentence in the credits history. A `steward_review` type was drafted here first
and dropped on finding it: a second name for a thing the vocabulary already has
is the failure D-002 refuses under _one record, or none_.

**2. The amount is 5 credits per quest decided, and it is paid once per quest.**

Five US cents. Three things fix it:

- **It is independent of the quest's value**, which is the whole of C. A review
  of a 60-credit quest and a review of a 6,000-credit quest are the same reading
  and the same judgement.
- **It is small enough that reviewing is not a way to earn.** A steward that
  decided every quest the Colony has ever had would hold a few cents.
- **It is large enough to be visible in a balance**, which the smallest possible
  figure — one credit, the pilot report price — would not be. A review is a
  larger unit of work than answering one report, and 5× is the smallest ratio
  that says so.

**Per quest decided, not per call**, which is what bounds it: a quest can be
decided once, so a queue of three quests pays out fifteen credits in total across
all stewards however many times anybody looks. There is no repeat to farm.

**It is paid from the Treasury and not from the fee that quest generated**, and
at today's prices those are different things: the fee on a pilot quest is zero,
so the first steward payments come out of the Treasury's bootstrap balance.
**That is stated here rather than discovered**, because a mechanism that silently
pays nothing is worse than one that was never built.

**3. Moderation and verification are not paid, and §4 is corrected to say so.**

§4 names steward review, moderation and verification in one breath. Two of those
are machines and one is not. The fee covers all three as **costs the Colony
bears**; only one of them is a payment to a citizen. That distinction will not
hold forever — a human moderator is a plausible year-two arrangement — and when
it stops holding it is a new decision rather than an extension of this one.

### What would reverse this

**A steward that decides carelessly because the payment is guaranteed.** C buys
impartiality by paying for the act rather than the outcome, and the cost of that
trade is that a fast wrong decision pays the same as a slow right one. Nothing
here detects that; what would is the sampling audit (`#221`) reaching published
quests. If it ever shows a steward's refusals or releases diverging from what a
second reader would have said, the answer is a check on the decision and not a
change to the price — repricing would reintroduce exactly the interest this
decision removed.

**A fee that is no longer zero.** Once real quests pay real amounts, the Treasury
receives a fee per accepted report and the question of whether 5 credits is the
right flat figure becomes answerable against a number rather than against
judgement. Revisit the amount then; do not revisit the flatness.
