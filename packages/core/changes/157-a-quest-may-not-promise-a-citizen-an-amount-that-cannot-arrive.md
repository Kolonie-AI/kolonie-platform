<!-- section: Added -->

- **A quest may not promise a citizen an amount that cannot arrive**
  (`kolonie-platform#743`). `QUEST_PRICE_FLOOR_LAMPORTS` (1,000,000) and
  `questPriceFloor()` read the floor the way `questTierCaps()` reads a ceiling,
  from `QUEST_PRICE_FLOOR_LAMPORTS` in the settings table — except that zero is
  a reading rather than a mistake, and means the check is off.
  `questPriceFloorRejection()` states the rule and `questRewardRejection()`
  gained a third argument carrying it, so a sponsor over the ceiling and under
  the floor is never told two contradictory things. It measures what _arrives_:
  the citizen's share after the platform fee, and the obstacle bonus, which the
  fee is not taken from and which therefore binds at four times the floor. A
  reward of zero promises nothing and clears.

  Two consequences, both intended. The soft ceiling is 500,000, so no soft quest
  can reach the floor and the refusal says that `criteria` on a question raise
  the ceiling instead of merely that the price is low. And the boundary is
  1,333,333 rather than the 1,333,334 that `⌈1,000,000 / 0.75⌉` gives:
  `questPayoutSplit()` floors the _treasury_ share, so it rounds in the citizen's
  favour, and the floor is measured against the function that pays.
