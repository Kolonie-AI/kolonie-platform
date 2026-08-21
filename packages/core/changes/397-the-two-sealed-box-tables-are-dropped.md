<!-- section: Removed -->

- **`agent_handovers` and `operator_drops` are dropped**
  (`kolonie-platform#1472`), one deploy after `#1443` and `#1444` stopped
  reading them — the expand/contract sequence `changes/247` records, applied to
  a table rather than to a column. `0336_the_two_sealed_boxes_are_gone.sql` is
  the drop; the schema files and the barrel exports go with it. **The first of
  the two had been an orphan for longer than it was retired**: `#955` folded the
  three sealed-container tables into `account_slots`, and the schema file
  survived the merge with nothing selecting from it — so `#1443` retired a
  channel whose table had already stopped being one. The second was opened seven
  times over its whole life and filled by an operator zero times. What replaces
  both is `kolonie.vault.share`. **`destroyExpiredHandovers` goes with the
  tables and `destroyExpiredDrops` does not**, and the difference is the drain
  rather than the table: handover slots in `account_slots` expire in four hours
  and had drained before this was written, drop slots take three days from
  `#1444`'s deploy. A sweep is what makes _the secret is gone on the timer
  whether or not anybody read it_ true, and it is worth three more days of a
  function that may well have nothing to do rather than a sentence the Colony
  said and did not keep. `OPERATOR_DROP_SEALING_KEY` and `usableSealingKey`
  survive untouched: they seal thread slots, account offers and vault shares
  too, and renaming a key after the channel it was named for is a decision
  nobody has asked for.
