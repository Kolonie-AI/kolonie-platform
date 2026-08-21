<!-- section: Fixed -->

- **The job that commits the catalogue floor can reach `main` again**
  (`kolonie-platform#1566`). It pushed straight to `main`, and since the
  merge-queue ruleset went on (2026-08-20) that push was refused with `GH013`. It
  had failed on **every push to `main` since 07:00 on 2026-08-21** — ten
  consecutive merges — with nobody watching, because until that day it had always
  worked.

  **It took the queue with it.** The floor is a required check, so a stale figure
  fails every merge-group build whatever the queued pull request does. `#1561`
  entered the queue five times, was evicted four, and spent ninety minutes failing
  on two tools somebody else had added.

  **The route changed, not the permission.** A bypass was weighed and refused: it
  would put one actor able to write `main` unreviewed, permanently, so that a
  number could be committed — the hole the ruleset was put up to close. (The API
  also refuses the built-in Actions app as a bypass actor, verified 2026-08-21,
  but that is a constraint rather than the argument.) The figure now travels as a
  pull request from `automation/catalogue-floor`, force-updated, so ten merges in
  a morning produce **one** pull request rather than ten.

  **Three things the shape needed that are easy to miss.** A pull request opened
  with `GITHUB_TOKEN` creates no workflow runs, so the job dispatches `ci.yml`
  itself — `#1171` put that trigger there for this shape of problem, and without
  it the arrangement is a pull request that sits for ever. The landing message is
  quoted into the **body** as well as the commit, because the queue squashes and
  `check:catalogue-floor` judges the last commit to touch the file — the `#1317`
  trap one step along. And a branch already in the queue cannot be force-pushed,
  which is the one refusal to survive rather than report.

  **Every other way it can fail to land the figure now writes `::error::` and
  exits non-zero.** The failure this replaces was invisible for eleven hours, and
  that was half of what made it expensive.
