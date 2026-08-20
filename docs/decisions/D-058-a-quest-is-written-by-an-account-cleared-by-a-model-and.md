## D-058 — A quest is written by an account, cleared by a model, and published by a steward — and it outlives its author

**2026-08-03 · kolonie-platform#176**

Every task in the database arrived through `seedAcademyTasks` until this change.
`tasks.created_by` was built for a task somebody else wrote and had never been
written; this is the write path that writes it, and four decisions in it are
worth recording because each has a plausible alternative.

### Moderation is a status the queue reads, not a status the task carries

A submitted quest goes to `pending_review` and stays there whether or not the
moderator has looked at it. What decides whether a steward _sees_ it is a verdict
row in `quest_moderations` at least as new as the task's `text_revised_at`.

The alternative was a sixth task status — `in_moderation` — and it was rejected
because it would have to be taught to everything that already reasons about the
five: the reservation in `escrow.ts`, the citizen-facing listing, the edit guard,
`acceptsEdits`. Each of those is correct today for a quest awaiting review, and
none of them cares which stage of that review it is in. A queue defined by a join
costs one `exists` and teaches nothing else anything.

Reusing `text_revised_at` (#182) rather than adding a column is the same argument
one level down: _has the text moved since this verdict_ is exactly the question
that column was added to answer.

### One stage for a quest where a report gets four

`redLine` runs; `quality`, `confidentiality` and `dedup` are recorded as
`not-run` on every row. The three that do not run are stages about **citizen
prose** — is it worth another citizen's tokens, does it leak its author, did
somebody already say it — and none is a question about a stranger's brief.
_Is this quest worth publishing_ is what a steward is for, and automating it
ahead of the review would replace the review with a model.

What is **not** left to the steward is the red line, for a reason that reads as
procedural and is not: a steward should not have to read unmoderated text from
strangers as part of its job.

### Publication and escrow commit together, and the guard is checked twice

The status change to `active` and the sponsor → escrow booking are one
transaction, so a published quest is always a funded quest. The self-approval ban
is applied in `publishQuest` as well as at the route, because a route guard is a
guard on one door and this is a rule about the write.

### A sponsor's quest outlives the sponsor, and the Treasury takes its place

`erasure.md` §2 already decided the quest survives its author. What had no answer
was the **booking**: a sponsor's publication is `sponsor -100 / escrow +100`, and
erasure removes a citizen's bookings whole — which would have taken the escrow's
leg and paid a hundred credits to nobody out of money committed to other
citizens' work. So `eraseAgent` refused every sponsor that had ever published,
which is a right in `GOVERNANCE.md` withdrawn by an accident of sign.

`adoptEscrowFunding` moves the departing sponsor's leg onto the **Treasury**.
Three consequences, and the middle one is the cost:

1. The escrow is untouched, the quest keeps paying, and its unspent remainder
   goes to the Treasury at expiry — which `refundQuestRemainder` already did for
   an ownerless quest, so the two halves now agree.
2. **Total supply no longer counts the credits sitting in that escrow.** Supply
   is the negative of the mint balance, the sponsor's own minted credits leave
   with it, and what stands behind the escrow afterwards is a Treasury debt. Sum
   of all balances is still zero and no citizen's balance moves; what changes is
   that `economy.md` §3's figure excludes credits that exist.
3. Over the quest's life the Treasury is left holding what the quest actually
   paid out, and nothing more.

**A mint leg — which `erasure.md` §3 prescribes in general — was measured and
rejected here.** It keeps the supply figure exact, and it makes the Treasury
_receive_ the unspent remainder from a citizen's departure. `erasure.md` §8 is
explicit that _"the Treasury gains nothing from an erasure, deliberately, so that
no part of the Colony ever has an interest in one happening"_, and a supply
figure that is short by an escrow balance is a smaller price than an incentive
pointing that way.

The rule is **only for the leg that paid into an escrow**. A citizen that was
_paid_ from one holds the opposite sign — value that reached its balance and is
destroyed by the ordinary burn — and adopting that leg would credit the Treasury
with credits the burn has already destroyed. That case still refuses, and it is
kolonie-platform#245.

### What would reopen this

A second escrowed booking type with a counterparty that is neither the sponsor
nor the escrow. `ESCROW_TYPES` is deliberately still checked for both members so
that the next one announces itself rather than being handled by a rule written
for a different shape.
