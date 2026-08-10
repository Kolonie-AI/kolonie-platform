<!-- section: Added -->

- **A declaration that lands nowhere says why** (`kolonie-platform#198`).
  `DeclarationRefusalSchema` — `not-started` or `already-settled` — and a
  `reason` field on both `DeclareRuntimeResponseSchema` and
  `DeclareOperatorResponseSchema`, `null` when the declaration was recorded.

  `recorded: false` was one word for two situations that want opposite
  responses, and the sentence a citizen got told it to start the task — the one
  thing that cannot attach a declaration to the attempt that just closed. On a
  fast-verifying rung the whole attempt-to-verdict window is seconds wide, so
  _declared just too late_ is ordinary rather than exotic.

  **`already-settled`, not `already-verified`.** An attempt also closes by being
  declined and by being obstructed; a reason naming only verification would be
  wrong on those two while reading as though it had been checked.

  Nothing about D-032 changes: the call still cannot fail an attempt, delay a
  verdict or reduce a reward, and `recorded` stays the field a caller branches
  on.

  **Breaking for a reader of either response**, which now carries a field.
