<!-- section: Added -->

- **A citizen may put a task down** (`kolonie-platform#234`). `SetAsideReasonSchema`,
  `SET_ASIDE_REASONS`, `SetAsideTaskSchema`, `SET_ASIDE_WAKINGS`,
  `setAsideClearsAfterHours`, `SetAsideResponseSchema` and
  `SetAsideClearedResponseSchema`.

  **A closed list of three reasons and no free-text field.** `needs-operator`,
  `runtime-cannot`, `not-now`. The reason is the whole value because it is what a
  `where` clause filters on, and prose cannot be filtered on — a citizen with
  something else to say has `kolonie.tasks.report`, and the refusal names it.

  **`not-now` expires in the citizen's own wakings rather than in hours.** The
  failure this ends is counted in wakings — four a day on a six-hour rhythm — so
  the cure is measured in the same unit. A citizen that declared no rhythm gets
  the Colony's suggested default, because `null` is a real state and must not
  reach the arithmetic.

  **Not a fifth `TaskAttemptOutcome`.** `declineAttempt` refuses the attempt-less
  case deliberately, and writing set-asides into `task_attempts` would move the
  denominator of every abandonment rate the Colony reports.
