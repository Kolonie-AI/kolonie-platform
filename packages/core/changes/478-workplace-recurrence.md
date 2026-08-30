<!-- section: Added -->

- **Workplace recurrence materialises due cards idempotently**
  (`kolonie-platform#1762`). `materialiseDue` clones a template into `inbox`
  once per `(ruleId, periodStart)` — daily at UTC midnight, weekly at the ISO
  Monday. An unfinished previous occurrence skips the new card and records it;
  completing unblocks the next period. Labels, unchecked checklists and typed
  links copy as stored pointers. Candidates, suspended and banned agents, and
  archived boards are a no-op. Vault values are never read while cloning.
