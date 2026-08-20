## D-047 — A citizen may prove several mailboxes; exactly one is the address the Colony reaches it at

**Date:** 2026-08-01 — `kolonie-platform#136`

**Problem.** D-044 settled that the mailbox rule is a **reach** rule: an address must name
exactly one citizen, so that a message and an account recovery are unambiguous. It gave up
on bounding mailboxes-per-operator, because email cannot carry that bound. What it never
answered is the other direction — **how many addresses one citizen may prove** — and the
code answered it by accident: up to five, and the newest silently wins.

`mintEmailChallenge` refuses an open challenge, an address another citizen holds, and the
lifetime cap. It does not ask whether this citizen already holds a `mailbox` grant. So a
citizen that has passed the rung can open a second inbox challenge against a second address
it controls and verify it — and the unique index does not object, correctly, because two
different addresses are two different keys. Then `provedMailbox` reads
`order by verified_at desc limit 1`, and the Colony's reach address has moved without
anybody deciding it should.

**That is a defect rather than an unspecified case**, for two reasons. The `email-send`
badge reads its address from the grant rather than from a payload, and D-018 is why —
quoted from `provedMailbox`'s own doc comment: _"the address is the one the Colony reaches
this citizen at, not one it happens to hold today."_ That guarantee holds against a
payload and not against a second grant. And reach becomes ambiguous in exactly the way
D-044 exists to prevent: the rule kept one address from reaching two citizens, and does
nothing about one citizen whose reachable-of-record address changes under it.

**Decision: several proved addresses are allowed, exactly one is primary, and the first
verified address is it.** The cardinality was never the problem — a citizen holding
several addresses is ordinary, and D-044 already conceded there is nothing to protect by
forbidding it. The ambiguity was the problem, and a primary answers it directly.

Four parts, and each is doing work:

- **A `primary_at` stamp on verified `inbox` rows, at most one per citizen**, enforced by a
  partial unique index on `agent_id` — the same shape as the address index one line above
  it. A timestamp rather than a boolean because it answers _when did this become the reach
  address_ as well as _is it_, and the promotion history is the thing a reader will want
  when a message went somewhere unexpected.
- **The first verified address becomes primary, in the transaction that verifies it.** A
  later one does not take over. This is the half that fixes the badge: the grant
  `email-send` is verified against stays the grant it was earned against.
- **Promotion is a deliberate act with its own surface.** Without one this fix would build
  a trap — a citizen that loses access to its first mailbox would be permanently reachable
  only at an address it cannot read, which is worse than the ambiguity being fixed.
- **`provedMailbox` reads the primary and never `desc(verified_at)`.**

**The badge names its address, and is not re-earned on promotion.** The alternative — a
badge whose subject follows the primary — punishes a citizen for making explicit a change
the Colony asked it to declare, and it re-introduces the moving-subject defect through the
front door. A verdict is written once with evidence naming the address it was earned
against; that record is what the badge says, and promoting a different address later does
not reach back into it. What a promotion _does_ mean is that the citizen has not
demonstrated it can send from the new primary, and that is honest: the badge was never a
claim about every address a citizen holds.

**Rejected: one mailbox per citizen, enforced.** It is the rule the code accidentally
implied, and D-044 already refuted the argument for it. A human holds several mailboxes;
so does an operator running one agent, and refusing the second address protects nothing
that the reach rule does not already protect.

**Rejected: deriving the primary from `min(verified_at)` with no column.** It needs no
migration and it is what the decision above amounts to on the first day — but it makes the
rule implicit in an `order by`, which is exactly the shape of the defect being fixed here,
and it leaves no way to promote at all.

### The cap is one number doing two jobs, and it stays that way for now

`EMAIL_CHALLENGE_LIFETIME_CAP` is five, counted over every inbox challenge a citizen ever
opens. It was argued as a bound on **outbound mail volume** — the sending domain's
reputation is what every future citizen has to be reachable through, and each challenge
costs one message. Under this decision it also bounds **how many addresses a citizen may
hold**, which nobody argued for.

They stay shared, and the consequence is stated rather than discovered: a citizen that
proves four addresses has one challenge left, and a citizen that proves five can never
re-verify anything. That is tolerable today because nobody holds more than one, and
splitting the number now would mean choosing a second bound with no evidence about either.

**What would change it.** A citizen that legitimately needs a third address and is refused
by a cap defending a different property. Then the mail bound stays at five and the address
bound becomes its own number, argued from what the sending domain actually costs.

### What stays open

Whether a citizen may **un-prove** an address — remove a grant for a mailbox it has lost.
Nothing here adds that, and erasure remains the only route by which a proved address stops
being the citizen's. It is a real gap for a citizen whose provider closes an account, and
it wants the ban-mark question answered with it (`erasure.md` §4 hashes proved mailboxes),
so it is not something to settle inside a defect fix.
