<!-- section: Fixed -->

- **A floor pull request is left alone while its own checks are still running**
  (`kolonie-platform#1594`). Every push to `main` measures the catalogue and
  force-pushes the figure onto `automation/catalogue-floor`. `ci.yml` sets
  `cancel-in-progress: true` on branch refs, which is right for a branch somebody
  is iterating on and wrong for one trying to reach a verdict: the force-push
  cancels the runs already going and starts a fresh set.

  At the rate this repository merges — 49 on 2026-08-21 — the next measurement
  arrives before the previous verdict does. Measured on `#1590`: two full rounds
  of runs on one pull request, neither of them concluding. The pull request reads
  `MERGEABLE` and `auto: true` the whole time, and never goes green.

  **So the job now looks before it pushes.** If the floor pull request has checks
  pending, the newer figure is dropped and the run says so with a `::notice::`.
  The push to `main` after the pull request merges measures again, and that
  measurement is the one that lands.

  **Dropping a figure is safe, and this is the whole argument.** A floor that lags
  is a floor _below_ the catalogue: it costs strictness while it lags and cannot
  cost correctness, because a branch is weighed against its merge base (`#1266`)
  and never against this file. There is no deadline on the number.

  **Past an hour it pushes anyway**, with a `::warning::`. An hour is the queue's
  own `check_response_timeout_minutes` — past it the checks are stuck rather than
  slow, and stranding the figure behind them for ever is the worse of the two
  failures.

  **The rejected repair was a deadband on the ratchet** — measure every time,
  write only when the move is large. Skipped writes accumulate, so the eventual
  write clears `CATALOGUE_BYTE_TOLERANCE` and demands a justification sentence
  nobody authored, which is `#1583`'s deadlock arriving by a longer road.
