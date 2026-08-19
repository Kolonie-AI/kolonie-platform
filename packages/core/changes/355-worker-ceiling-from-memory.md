<!-- section: Changed -->

- **The `apps/api` worker ceiling is derived from memory rather than from cores**
  (`kolonie-platform#1354`, correcting `#1350`). `#1350` gave the workspace
  `min(6, cpus - 2)` and fixed what it was for — fifteen timeouts in 12m 12s
  became 4381 green in 1m 46s on the host where the failure lives. It also cost
  CI **23 %**, measured as an A/B on two pull requests running a minute apart:
  471 s without the change, 580 s with it. On a four-core runner the rule asks
  for two workers where the published budget already allows four, and that runner
  has 16 GiB and no memory problem at all — it was being lowered by arithmetic
  derived from a 7 GiB laptop.

  The constraint was always memory; `packages/db`'s own comment says so — _the
  ceiling is memory, not cores_ — and then multiplies by cores anyway.
  `memoryCeiling()` is that sentence with the arithmetic to match: total memory,
  less a 2 GiB reserve for what is already resident, over 1200 MiB a worker,
  capped at six. Both numbers are measured rather than chosen — four workers
  peaked at 6405 MiB against a 1790 MiB baseline, so about 1150 MiB each.

  It gives this host 4 (the configuration that passed) and a 16 GiB runner 6,
  which the published budget then lowers to 4 — back to what CI had.
  `testWorkers` still only lowers, so nothing here can raise what
  `npm run check` publishes. `packages/db` keeps its core-derived rule: nobody
  has measured that suite, and changing a ceiling on the strength of a
  measurement of a different workspace is how the next one of these gets filed.
