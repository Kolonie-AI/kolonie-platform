<!-- section: Fixed -->

- **A local `npm run check` no longer fails a branch for growth `main` is the one
  to record** (`kolonie-platform#1483`). `#1465` moved the catalogue floor off
  branches — `main` measures the surface after a merge and commits the figure, and
  AGENTS.md §4 tells authors the floor is not theirs to edit.
  `catalogue-budget.test.ts` did not get that message: its live-catalogue
  assertion still weighed the measurement against the committed floor with no
  tolerance and read no justification, so it failed on any growth at all.

  Measured on `#1434`, which added two optional fields and no tool: 217,582 bytes
  against a floor of 217,025, red locally and red in CI's required `test` job.
  **The workaround was to raise the floor on the branch after all**, which puts
  back the collision `#1465` removed — so the fix was available to anyone who
  ignored the documentation and unavailable to anyone who followed it.

  It now makes the call the branch gate makes: `branchBudgetVerdict`, the
  1024-byte tolerance, and the pull request's own words read from
  `CATALOGUE_FLOOR_PR_TEXT_FILE` / `CATALOGUE_FLOOR_PR_TEXT` — the same two
  variables `check-catalogue-floor.mjs` already reads. One rule in three places
  rather than a rule per place. `budgetVerdict` is unchanged and is still what
  `main` runs.
