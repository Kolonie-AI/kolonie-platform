<!-- section: Fixed -->

- **A red-on-main quote no longer carries vitest's colour codes**
  (`kolonie-platform#1362`). `gh run view --log-failed` leaves ANSI escapes and a
  job/timestamp prefix on every line; in a markdown fence they read as a
  corrupted paste, which is the first instinct a reader of a p1 issue distrusts.
  The escapes are stripped; the prefix is stripped only where the line actually
  has that shape, because the column layout is not a contract.
