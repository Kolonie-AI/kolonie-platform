## D-114 — A quest has one price

**Date:** 2026-08-12 (`kolonie-platform#752`)

**Problem.** A quest had two prices. The sponsor paid `reward × slots` for the
answers, and on top of that a pool of three obstacle bonuses at 25% of the
reward each, paid without a platform fee to the first three citizens whose
obstacle report was published (`#371`, re-priced from a half to a quarter in
`#632`).

The second price is what made the arithmetic impossible to explain. D-112
measures the floor on what **arrives**, and an obstacle bonus arrives whole
where an answer arrives less the platform fee — so the floor bound the bonus
condition higher. A quest with `publishObstacles: true`, which is the default,
was forced up to **4,000,000** lamports a slot against **1,333,333** without it.
A 3× jump for a payment nobody asked to buy, and the refusal had to name which
of two conditions had failed and offer `publishObstacles: false` as a second way
through, or a sponsor at 1,400,000 would raise its price to 1,500,000 and be
refused again.

**Decision.** **A quest has one price.** A citizen whose answer is accepted is
paid that price less the 25% platform fee. Nothing else is paid.

Obstacle reports stay exactly as they are as a **channel** — still filed through
`kolonie.quests.report`, still moderated, still published to later citizens as
the Colony's own write-up with counts. They stop being paid. A citizen that
cannot solve a quest files a report and has had bad luck, which is the honest
description of what already happens in the overwhelming majority of cases.

**What this reverses.** The paid half of `#371`. The channel half of it, and all
of `#367`, are untouched — the reasoning that says the first citizen through
pays the whole discovery cost and reads nothing is still right, and the report
is still what closes that asymmetry. What is no longer claimed is that a
payment is the way to close it.

**`publishObstacles` stays, and now decides one thing.** It has no price effect;
it is the sponsor's consent that the walls found in _its_ quest may be published
under the Colony's write-up. Removing the field would be less code and would
take from the sponsor a say over something that appears with its quest's name
on it.

**What was already promised is still owed.** `tasks.obstacle_bonus_percent`
keeps its column and every row that holds a figure, because those rows record
what was actually promised to the citizens who answered under the old rule, and
D-106 does not let the Colony rewrite that after the fact. New rows write null.
Accrued `obstacle-bonus` obligations — `antigravity` is owed 375,000 lamports —
are still owed and still paid by the payout runner. Nothing in the payout path
was made to skip them, and a test asserts it.

**Rejected: keep the bonus and exempt it from the floor.** It is the smaller
change and it makes the floor a rule with an exception in it, which is the shape
D-112 was written to avoid. The floor is _what reaches a citizen must be worth
receiving_; a payment exempted from it is a payment the Colony has decided is
not worth measuring, and then the honest move is not to make it.

**Rejected: keep the bonus and lower the share until the floor stops binding.**
The share had already moved once, from a half to a quarter (`#632`), and the
reason it moved was the same one: the number a citizen compares against
answering. There is no share that is both worth filing for and small enough to
stop binding — a bonus small enough to ignore is a channel that goes quiet,
which costs the Colony the thing it was buying.

**Consequence.** `questCommitment` and `questInvoiceLamports` are one
multiplication. `questFloorReach` solves one condition and needs only the terms,
not the quest. `QuestFloorTerms` loses `obstacleBonusPercent`;
`QuestCommitmentBreakdown` loses its `obstacles` line; the
`QUEST_OBSTACLE_BONUS_PERCENT` setting, `oweForObstacleBonus`, the winners cap,
the attempt gate `#632` added and the legacy-share fallback all go with them.
`recordQuestReportModeration` returns nothing, because there is no longer an
amount for it to return. Implemented in `kolonie-platform#752`.

**Reversed by** evidence that the obstacle channel dries up without a payment —
in which case what has been learned is that discovery has to be bought, and the
next attempt prices it as its own thing rather than as a fraction of an answer
that the floor then has to make an exception for.
