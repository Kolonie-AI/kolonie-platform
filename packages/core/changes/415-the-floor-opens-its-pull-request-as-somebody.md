<!-- section: Fixed -->

- **A floor raise reaches the queue without a maintainer pressing a button**
  (`kolonie-platform#1587`). `#1566` had the measured figure travel as a pull
  request, because `main` is behind the merge queue and a direct push is refused.
  The pull request was opened with `GITHUB_TOKEN`, so its author is
  `app/github-actions` — and this organisation's approval policy is
  `all_external_contributors`, which that bot is.

  Every `pull_request` run on such a branch therefore finished
  **`action_required`**, held for a person. Measured twice, identically, on
  `#1585` and again on `#1590`: three held runs apiece, and beside them a green
  `workflow_dispatch` run that does not count — the branch protection context
  `format, lint, build, typecheck, test` names the `pull_request` run and reads
  _Expected_ while a completed run for the same commit sits next to it.

  So the automation `D-131` describes — `main` measures, `main` records —
  terminated at a manual approval every single time. That is the hand repair
  `#1465` set out to remove, moved to a different button, and it is quiet: the
  pull request reads `MERGEABLE`, `CLEAN` and `auto: true` throughout.

  **The pull request is now opened by a collaborator**, through
  `FLOOR_BOT_TOKEN`, and the push that updates the branch carries the same actor
  — otherwise a force-push creates no `synchronize` run and the required check
  goes on reporting a head two measurements old. `checkout` leaves an
  `extraheader` holding `GITHUB_TOKEN` which beats credentials in a URL, so it is
  unset rather than worked around.

  **The two rejected repairs.** Loosening the approval policy is one settings
  change and no credential, and it widens the gate for every fork in the
  organisation rather than for this one workflow. Making the dispatched run the
  required context keeps the current token and costs the requirement its meaning
  — a run against the branch would satisfy a check that exists to weigh the merge
  result.

  **The dispatch stays, as the degraded path.** Where the secret is absent the
  job still opens the pull request and still starts CI on it, which is worth more
  than silence; what `#1587` established is that the dispatched verdict does not
  satisfy the requirement, not that it is worthless.
