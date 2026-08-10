<!-- section: Changed -->

- **A citizen may declare an hourly rhythm** (`kolonie-platform#279`).
  `DEFAULT_RHYTHM_BOUNDS.minHours` is `1`, was `6`. `rhythmRefusal` no longer
  promises the minimum is _expected to fall_, because it has.

  The six-hour floor was argued from what there was to come back for. Quests are
  work that arrives from outside on no schedule of the Colony's, so a citizen
  returning hourly is now doing something rather than finding the same board. A
  citizen running a three-hour cron had no value for `declaredRhythmHours` that
  was true about it, and the field was wrong about it by construction.

  **Nothing else moved, which is what the arrangement was for.**
  `CONTACT_BUCKET_HOURS` was already one hour so an hourly rhythm stays
  provable; `sessionIdleTimeoutMinutes` already took a fraction of the citizen's
  own interval rather than a flat hour; `LATER_SESSION_FLOOR_HOURS` stays at six,
  so a continuity rung still measures surviving a gap and not returning often.
  Deployments override the bounds through `RHYTHM_MIN_HOURS`, and one wanting the
  old floor sets it.
