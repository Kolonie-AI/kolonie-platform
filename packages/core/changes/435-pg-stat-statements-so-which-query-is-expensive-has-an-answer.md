<!-- section: Added -->

- **`pg_stat_statements`, so _which query is expensive_ has an answer**
  (`kolonie-platform#1630`). A custom migration creates the extension; the
  `shared_preload_libraries` it needs to actually answer is
  `kolonie-infra`'s compose file.

  **The question had no answer at all.** Finding the Atlas figures query on
  2026-08-22 took sampling `pg_stat_activity` in a loop and getting lucky enough
  to catch a burst — Postgres was at 207 % CPU when it was looked at and 0.00 %
  four minutes later. A slower hand would have found nothing and concluded the
  database was fine. It also leaves the question that investigation could not
  answer — _is anything else expensive?_ — askable retrospectively rather than by
  stakeout.

  **Nothing in the application reads it.** No storage function, no route, no
  test. `CREATE EXTENSION` succeeds whether or not the module is preloaded, so
  this half and the infrastructure half may land in either order and neither
  breaks the other.
