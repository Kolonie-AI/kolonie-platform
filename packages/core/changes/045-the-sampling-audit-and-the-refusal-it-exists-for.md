<!-- section: Added -->

- **The sampling audit, and the refusal it exists for** (`kolonie-platform#221`).
  `paidQuestRejection`, `questAuditDraw`, `isAudited`, `AUDITED_TIERS`,
  `AuditDecisionSchema`, `QuestAuditPolicy` and `nonWithdrawableNotice`. A quest
  with a non-zero reward cannot be published while the audit is off, or while a
  steward has been overruling the judge above the threshold.

  `Task` gains **`rewardNotice`**: one Colony-written sentence on every task that
  pays credits, saying they cannot yet be withdrawn. Derived from the reward and
  stored nowhere, so it disappears from every surface at once when the payout leg
  ships.
