## D-110 — The quest ceilings and a steward's pay are denominated in lamports, and float in dollar terms

**Date:** 2026-08-08 — `kolonie-docs#225`.

**Problem.** D-106 settles everything in SOL, and `kolonie-platform#553` removes
Quest Credits. Enumerating every reader of the unit turned up two that are
neither already ported nor about to become dead — **both are decisions somebody
took, in cents, and nobody had taken again**:

- `QUEST_TIER_CAPS` — 1000 / 100 / 5 credits, which `governance/quests.md` calls
  ten dollars, one dollar and five cents, and which `questRewardRejection`
  compares against on the quest write path and in the console's quest form.
- `QUEST_REVIEW_REWARD_CREDITS = 5` — five cents, flat, paid to a steward's
  **credit balance** for each quest it decides, under D-105. **Gone since
  `kolonie-platform#724`** — see the note on D-105. Decision 1, the ceilings, is
  unaffected and is the half of this record still in force.

Both sit on the quest write path, so `#553` cannot proceed past either.

**It cannot be converted by an implementer**, which is why this is a decision and
not a line in a commit. Ten dollars is not a number of lamports: it is a number of
lamports _at a price_, and the price moves.

### Decision 1 — the ceilings are lamports, and the ratio is what was ever decided

```
hard           100_000_000 lamports   0.1    SOL
colony-judged   10_000_000 lamports   0.01   SOL
soft               500_000 lamports   0.0005 SOL
```

**200 : 20 : 1, unchanged.** That ratio is the argument `governance/quests.md`
makes; the absolute figures only ever followed a price. For scale rather than for
arithmetic, at **USD 74.52/SOL measured 2026-08-08** they are about $7.45, $0.75
and $0.037 — near the old intent, and already out of date by the time anybody
reads this. **The lamports are the rule.**

**Why not convert at write time.** It needs a USD/SOL price the Colony does not
have and would have to fetch, cache and occasionally be wrong about. A ceiling
that depends on a third party makes a quest refusable for a reason the sponsor
cannot see, and it puts an outbound call on the write path — the same shape this
repository refuses everywhere else. Accepting that the ceilings float in dollars
is the honest cost of not having an oracle, and it is cheap: nothing the Colony
runs is within two orders of magnitude of any of them.

**Why the per-report ceiling was kept at all**, since `kolonie-docs#225` was right
that the argument for it had weakened. `governance/quests.md` justified it as
_"one typo away from a quest that empties a balance on its first accepted
report"_, and under D-106 there is no balance to empty — the sponsor pays an
invoice for capacity × unit, so a typo costs at the moment it is invoiced rather
than silently. **That argument is gone and is not what this rests on.**

What survives is a different one, and only the soft tier makes it plainly: _a
softly verified Quest must never pay more than the reputation it risks._ That is
not about protecting a sponsor's money. It is a statement about what the Colony
will let itself advertise — a claim that a citizen's unverified word is worth ten
dollars is a claim the Colony would be making, whoever paid for it. A ceiling is
the only thing standing between the tier names and their meaning, so dropping it
would not have been simplification; it would have been deciding something else.

**One consequence, named because it will otherwise be found as a bug.** The soft
ceiling is _below_ the chain's rent-exempt minimum (`RENT_EXEMPT_MINIMUM_FALLBACK`,
890_880), so a citizen's first soft payout cannot go out alone — it accrues until
it clears. `#505` already does exactly this for every payout and calls it
_"physics, not a threshold policy"_. It is not new: the pilot pays a hundredth of
the soft ceiling.

### Decision 2 — a steward is paid `1_000_000` lamports per quest decided

`0.001 SOL`, flat, either verdict — D-105 unchanged in everything except its unit
and its amount.

**Why not stop paying**, which was the fourth option and the only one available
here that was not available for the ceilings. D-105's argument is on the page and
survives the change of unit intact: _refusing is the decision the Colony most
needs done well_, and an unpaid role prices the careful no at zero. What changed
is that the payment is now **real** — five credits was a unit the Colony minted
for itself, and a lamport is not — so stopping would have been reversing D-105
under cover of porting it. If stewardship should be unpaid, that is D-105's
option A and it is argued there, on its merits, not decided as a side effect of
D-106.

**`kolonie-docs#225` worried that a transaction fee is a meaningful fraction of
five cents. Measured, it is not.** A Solana base fee is 5_000 lamports — half a
per cent of this payment. The real chain constraint is the rent-exempt minimum
above, and a steward's first review accrues through it exactly as a citizen's
first report does.

**Why 1_000_000 and not the five-cent equivalent** (≈671_000 at today's price).
A round number in the same ladder as the ceilings, three orders of magnitude
above the fee that carries it, and a figure nobody has to divide to read. It is
about seven and a half cents today rather than five — **which is a small rise and
is said plainly rather than buried.** Whether a steward is paid _enough_ is a
different question from which unit it is paid in: one steward is still the whole
review capacity (`kolonie-docs#194`), and repricing the role belongs to that
problem rather than to this one.

### What this does not decide

**Not the platform fee** (25%, D-097 / `kolonie-docs#185`), which is a percentage
and needed no porting. **Not the pilot's one cent**, which `#553` retires with
credits. **Not whether the ceilings are right** — only what they are counted in,
and that the ratio is unchanged.

**Reversed by** a USD/SOL move large enough that a tier ceiling stops meaning what
its name says — a hard quest that cannot pay for a merged pull request, or a soft
one that pays more than a citizen's word is worth. That is a re-take of these
three numbers at a new price, in this file, and not a case for an oracle.
