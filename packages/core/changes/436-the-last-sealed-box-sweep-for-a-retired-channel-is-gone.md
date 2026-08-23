<!-- section: Removed -->

- **`destroyExpiredDrops` is gone** (`kolonie-platform#1526`), which is the last
  thing the operator → agent secret channel owned. `#1472` dropped
  `agent_handovers` and `operator_drops` and took `destroyExpiredHandovers` with
  them; this sweep was deliberately left behind because the two channels drain at
  different speeds — handover slots in `account_slots` expire in four hours and
  had already drained, drop slots take three days from `#1444`'s deploy at
  2026-08-21 06:38 UTC. **What settles it is a number rather than the calendar.**
  Measured in production 2026-08-23: `select count(*) from account_slots where
channel = 'drop' and value is not null` is **zero**, against seven drop rows
  ever opened. Nothing can open or fill a slot on the channel any more, so that
  set is fixed and cannot grow back — the function had nothing to destroy and
  never will. Waiting out the drain was insurance against a filled row existing,
  and the count says none does. `kolonie.operator.drop.open`'s promise that the
  secret is _gone on the timer whether or not anybody read it_ is kept by a
  channel that carried no secret. `packages/db/src/storage/operator-drops.ts`,
  the barrel export, the `SubmissionQueue` member, the `databaseQueue` wiring, the
  loop's call and log line and the fake queue's counter all go together.
  **`OPERATOR_DROP_SEALING_KEY` and `usableSealingKey` stay untouched**: they seal
  thread slots, account offers and vault shares too, and renaming a key after the
  channel it was named for is a decision nobody has asked for (`#1444`, `#1472`).
  `destroyExpiredSlots` is now the only sealed-container sweep on the tick, and
  it covers a channel that is still live.
