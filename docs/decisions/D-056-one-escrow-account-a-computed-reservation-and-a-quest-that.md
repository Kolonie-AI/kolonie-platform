## D-056 — One escrow account, a computed reservation, and a quest that pays out of its sponsor's money

**Date:** 2026-08-02 — `kolonie-platform#174`.

### One escrow account rather than one per quest

`governance/quests.md` requires a published quest's reward to sit in escrow.
Where it sits was not decided, and the obvious answer — an account per quest — is
the wrong one. Per-quest separation comes from `reference`, which every entry
already carries and which `ledger/ledger.ts` already sets the pattern for:
_"`reference` and `created_at` are carried on every entry of the set."_

An account per quest would be a schema that grows a row per sponsor decision, and
the balance of any one quest is a `where` clause either way. `escrow` is one more
value in `system_account`, and `escrowHeldFor` is a prefix scan over
`quest:<id>:%`.

### Three events, three references, and why that shape

`quest:<id>:funding`, `quest:<id>:refund`, `quest:<id>:payout:<submissionId>`.

Everything one quest's money ever did is a prefix scan, and each event is
bookable exactly once — because uniqueness is enforced on `(reference, account)`
and the three references differ. Sharing one reference across funding and refund
would have made the index refuse the refund.

**The index went through three shapes before one worked**, and the failures are
worth recording because each looked right:

- `(reference, account_kind)`, copying `ledger_entries_task_reward_unique`. That
  index can key on `account_kind` because a reward is always one agent and the
  mint. A quest refund on an **ownerless** quest is escrow → treasury: two
  `system` rows, identical under that key, and the index refused the very
  transaction writing them.
- `(reference, coalesce(system_account::text, agent_id::text))`. Postgres refuses
  it — casting an enum to text is `STABLE`, not `IMMUTABLE`, and an index
  expression must be immutable.
- `(reference, agent_id, system_account)` with `NULLS NOT DISTINCT`. Correct, and
  this version of drizzle-kit does not emit it.

What shipped is one partial unique index per account side — on `agent_id` where
it is not null, on `system_account` where it is not null. Each is readable as
exactly what it enforces, and neither needs a cast.

### The reservation is computed, and a booking is not a reservation

Between submission for review and publication the credits are committed but
**nothing has happened**, and the ledger records what happened. So the
reservation is a sum over the sponsor's own `pending_review` quests — unspent
capacity times price — and the available balance is the ledger balance minus that
sum.

A reservations table would be a second place a balance lives and the two would
disagree. That is D-002's argument, made a third time; `#175` made it a second
time by refusing a `slots_used` column. There is a test asserting that no table
and no column in the schema is named for a reservation.

### Zero books nothing, and why the branch still exists

A zero-sum transaction of zero is not a transaction. `ledger_entries_amount_non_zero`
would refuse the row anyway, but the reason is older than the constraint: a ledger
full of rows recording that nothing happened exercises the deferred double-entry
trigger for nothing.

`kolonie-docs#130` then made this branch _not_ the pilot's path — a pilot quest
pays one cent precisely so that all four bookings execute. The branch stays
because an Academy task pays nothing and always will.

### A quest pays out of escrow; the Academy pays out of the mint

Same event from the citizen's side, completely different from the Colony's.
`bookTaskReward` branches on `tasks.kind` for **the ledger booking only** —
reputation, skills, roles, the account register and citizenship are the same
event whichever kind of task it was. An early return there would quietly have
made a quest pass worth less than an Academy one, and `#177` is explicit that the
skill a verifier normally grants is granted on a quest too.

The memo is passed through rather than rewritten, so a quest payout carries the
same rate record an Academy reward does. An entry that recorded fifteen credits
where the task says thirty, without saying which rate it booked at, is a
discrepancy a reviewer has to resolve against a submission row.

### The escrow may never go negative

`payQuestReport` reads the escrow before paying and throws if it holds less than
the price. Capacity is supposed to make that impossible — `#175` refuses a
submission once every slot is taken — but the two are different mechanisms, and
if they ever disagree the failure is an escrow lent against itself, paying one
sponsor's citizens with another sponsor's money.

It throws rather than returning an outcome: every caller is inside a verdict
transaction that has already decided the report is good, and there is no sensible
partial answer.

### An ownerless quest's remainder goes to the treasury

A sponsor that erases itself mid-quest leaves the quest standing with
`created_by` unset, which `tasks.ts` already implements and `erasure.md` §2
already argued. The consequence nobody had written down is that its unspent
remainder has nowhere to go. It goes to the Colony, because escrow holding money
for a quest that has ended is a balance that never nets to zero and therefore an
audit that never reconciles.

### What is deliberately not here

**There is no payment rail.** A steward credits a sponsor's balance by hand.
`#219` builds the way in, and `#220` records whose money it was; blocking the
whole quest programme on the legal-entity question would have been the wrong
order, and the absence is visible rather than papered over.

### What would reopen this

A sponsor needing its escrow segregated in law rather than in bookkeeping — a
regulated deposit, or a jurisdiction that treats pooled prepayments as client
money. That is an account per sponsor, not per quest, and it is a legal question
before it is a schema one.
