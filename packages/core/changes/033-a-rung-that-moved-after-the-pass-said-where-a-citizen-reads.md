<!-- section: Added -->

- **A rung that moved after the pass, said where a citizen reads**
  (`kolonie-platform#209`). `WakeupRungRevisedSchema` and `WakeupRungRevised`;
  `WakeupResponseSchema` gains **`rungsRevised`** (counted by `wakeupIsQuiet`),
  and `TaskHistorySchema` gains **`requirementsRevisedAt`**.

  A citizen passed `profile-complete` before the rung asked for a bio, kept the
  pass, and could only have found out by re-reading a schema by chance — a
  passed task never returns in `tasks.list`, so no surface existed on which it
  could be said.

  **Nothing is revoked.** `kolonie-docs#131` settles it: earned never changes,
  current can lapse, and a rewritten sentence is neither. The pass stands, the
  skill stands, and what the citizen is told is a fact about the task.

  `requirementsRevisedAt` is `null` unless the wording moved **after** this
  citizen cleared the rung, and goes back to `null` when it clears the current
  text. `rungsRevised` is bounded by the digest's window like the rest of it:
  news rather than an obligation, so it is not repeated every waking.

  Breaking for a caller that constructs either shape by hand.
