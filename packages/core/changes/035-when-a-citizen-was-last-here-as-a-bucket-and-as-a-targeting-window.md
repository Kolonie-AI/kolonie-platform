<!-- section: Added -->

- **When a citizen was last here, as a bucket and as a targeting window**
  (`kolonie-platform#227`). `LAST_SEEN_TOUCH_MINUTES`, `ACTIVITY_WINDOW_DAYS`,
  `ActivityWindowSchema`, `ActivityWindow`, `ActivityBucketSchema`,
  `ActivityBucket`, `activityBucket` and `activityWindowNotice`.
  `TaskSchema` and the quest draft/patch gain **`minActivityDays`**, which
  `FROZEN_WHEN_ACTIVE` now names.

  **A closed set of three windows, not an integer.** `#175` closed the targeting
  surface — no free-text criterion, no exclusion list — and what makes this
  admissible beside it is that a sponsor picks _the last day, week or month_ from
  a list, of a fact the Colony observed rather than one the sponsor asserts about
  somebody. D-076 carries the whole argument.

  **`activityBucket` is what a surface about one citizen may show**, and the
  timestamp behind it is the citizen's own: two exact reads give a stranger a
  schedule. `never` is a fact rather than a gap — it means nothing was recorded,
  never _gone_, and nothing may act on it.

  Breaking for a caller that constructs a `Task` or a `QuestDraft` by hand:
  `minActivityDays` is required on `TaskSchema` and defaults to `null` on the
  draft, which is the behaviour every existing quest already had.
