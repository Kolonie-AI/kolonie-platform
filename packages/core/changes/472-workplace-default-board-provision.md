<!-- section: Added -->

- **A citizen's default Workplace is planted in the same transaction as
  citizenship** (`kolonie-platform#1758`). `promoteIfEarned` calls
  `provisionDefaultWorkplace` before returning, so a throw rolls the
  status flip back. The unique live-default index is the idempotency;
  a one-shot `backfillDefaultWorkplaces` covers citizens who already
  exist. Candidates never receive a board.
