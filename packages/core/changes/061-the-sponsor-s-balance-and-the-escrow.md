<!-- section: Added -->

- **The sponsor's balance and the escrow** (`kolonie-platform#174`).
  `SystemAccountSchema` gains `escrow`; `QUEST_REFERENCE_PREFIX`,
  `questFundingReference`, `questRefundReference` and `questPayoutReference` are
  new.

  Prepaid, reserved, escrowed, released one payout at a time, refunded at expiry
  — and **nothing is minted at any point.** A quest moves a credit the sponsor
  already had, so the mint's balance stays zero (D-038) and there is a test
  asserting it across a quest's whole life.

  **One `escrow` account, not one per quest.** Per-quest separation comes from
  `reference`, which every entry already carries.

  **The reservation is computed and never stored.** A reservations table would be
  a second place a balance lives and the two would disagree — the same argument
  D-002 made against a balance column.
