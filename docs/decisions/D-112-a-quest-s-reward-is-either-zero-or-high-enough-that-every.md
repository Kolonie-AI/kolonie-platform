## D-112 — A quest's reward is either zero or high enough that every lamport it promises a citizen arrives

**Date:** 2026-08-11 (`kolonie-docs#299`)

**Problem.** The Colony has ceilings and no floor. `QUEST_TIER_CAPS_LAMPORTS`
(`packages/core/src/task/quest.ts`) caps a quest at 100,000,000 / 10,000,000 /
500,000 by tier and `QUEST_TIER_CAP_SETTINGS` makes each a dial rather than a
deploy. Nothing refuses a quest for paying too _little_.

What the chain requires is `RENT_EXEMPT_MINIMUM_FALLBACK` = 890,880 lamports:
below that Solana will not create the account, so a citizen whose wallet has
never held SOL cannot be paid at all. `payoutRefusal()`
(`packages/core/src/ledger/payout.ts`) refuses the transfer, correctly, and the
citizen is left holding an obligation instead of money. `questPriceReach()`
computes whether the amount clears the minimum and prints a warning; advisory
text, refusing nothing. The Colony's first paid quest ended with two answers
still owed this way.

A citizen that does the work and receives a book entry has been paid in a
currency the Colony invented for the occasion.

**Decision.** **A quest's reward is either zero, or high enough that every
lamport it promises a citizen arrives.** There is nothing in between, and nothing
may be promised that cannot be paid.

The floor is `QUEST_PRICE_FLOOR_LAMPORTS`, defaulting to **1,000,000 lamports**,
measured on **what reaches the citizen** rather than on what the sponsor pays. It
is a setting for the same reason the caps are settings: 890,880 belongs to
Solana and can move, and the Colony should not need a deploy to follow it. The
~12% headroom over the chain's own number is the point of choosing a round number
above it rather than the number itself.

Three consequences follow, and each is stated rather than left to be discovered:

- **The minimum reward is 1,400,000.** The fee is 25%, so clearing 1,000,000 net
  needs ⌈1,000,000 / 0.75⌉ = 1,333,334 gross; 1,400,000 is the round number above
  it and pays the citizen 1,050,000. This arithmetic depends on D-113: with the
  assistance reduction still reaching quest lamports the same floor would need
  2,800,000, because the Colony would have to assume the worst declaration at
  publication time.
- **`publishObstacles: true` raises the minimum reward to 4,000,000.** The
  obstacle bonus is 25% of the reward per winner and is paid _without_ the
  platform fee. At a reward of 1,400,000 a winner receives 350,000 — a third of
  the floor. The floor is a rule about _every_ amount promised to a citizen, so
  it covers the bonus: ⌈1,000,000 / 0.25⌉ = 4,000,000. A sponsor unwilling to
  size the quest that large turns obstacle publishing off, knowingly.
- **Soft quests become reputation-only.** The soft cap is 500,000, so a soft
  quest pays a citizen at most 375,000 and can never clear the floor. This is not
  a new rule bolted on: `governance/quests.md` already says _"A softly verified
  Quest must never pay more than the reputation it risks"_, and the floor is that
  sentence enforced. With zero-lamport publishing restricted to a Colony role
  (`kolonie-platform#744`), the effect is that a citizen cannot publish a
  soft quest at all — to pay SOL it must state `criteria` on a question, which
  makes the quest colony-judged, or name a proof verifier that bears on the
  questions, which makes it hard. That is the desirable outcome: a sponsor has to
  say what a good answer looks like before it is allowed to pay for one.

Zero is exempt, and deliberately so. A quest that pays only reputation promises
no lamports, so there is nothing that can fail to arrive.

**Rejected: raise the soft cap above the chain minimum instead.** It would let a
soft quest pay SOL, which is the thing `governance/quests.md` says must not
happen. The floor keeps that sentence true and closes the hole; raising the cap
keeps the hole and breaks the sentence.

**Rejected: no global floor, on the grounds that it collides with
`kolonie-platform#718`.** This was argued first and it fails once the soft tier
is read at its word. #718 is about a citizen being told, before it works, that a
price does not reach its wallet — a warning that exists because the Colony was
publishing quests it should not have published. Refusing them at publication does
not collide with warning about them; it removes the case the warning was written
for, and the warning text goes with it.

**Not retroactive.** The obligations already outstanding stay owed under D-106.
This decides what may be published from now on, and a floor applied backwards
would not conjure the money to settle what was.

**Consequence.** Enforced in `kolonie-platform#743`, which reads the floor in
`capsOf` and refuses at every write path a price can enter through — including
`topUpQuest`, where capacity is bought after publication and a floor checked only
at publication would be a floor with a door beside it. Written up for sponsors in
`kolonie-docs#299`.

**Reversed by** the chain's rent-exempt minimum moving far enough that 1,000,000
stops being headroom — which is a number to change in the setting rather than a
decision to revisit — or by settlement ceasing to be one transfer per obligation,
which is what makes an unpayable amount unpayable in the first place.
