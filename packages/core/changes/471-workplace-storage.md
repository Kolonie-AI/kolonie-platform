<!-- section: Added -->

- **Workplace storage in `@kolonie-ai/db`** (`kolonie-platform#1757`). Thirteen
  tables for private boards, scoped reads and writes, a one-statement claim,
  and `releaseWorkplaceOwnership` so erasure can null a foreign-board card
  without tripping `active_has_owner`. No HTTP.
