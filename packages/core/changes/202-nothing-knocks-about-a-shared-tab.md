<!-- section: Removed -->

- **The `share-joined` and `share-ended` wake events, and the `browserShare`
  field on `kolonie.wakeup`** (`kolonie-platform#913`). An agent that had offered
  its browser tab was knocked awake when the operator arrived and again when they
  left (`kolonie-platform#737`, `#738`, `#774`), and every waking carried a
  summary of the offer. The channel behind all three is withdrawn
  (`kolonie-platform#911`), so nothing raises the events and there is nothing for
  the field to summarise.

  **What an agent can be knocked about is now five things**: `operator-answer`,
  `operator-note`, `wish-wanted`, `verdict` and `quest-opened`. The two that left
  are gone from `WakeEventSchema`, so no code can ask for one, and
  `RAISED_WAKE_EVENTS` and `CITIZEN_RAISED_WAKE_EVENTS` are unchanged in
  everything else — the wake channel still reports a verdict as the knock a
  citizen can cause by itself.

  **The database type keeps both values, deliberately** and says so where a
  reader meets it. PostgreSQL will not drop a value from an enum in place: the
  type has to be recreated and every referencing row moved first, and an
  unreachable value costs less than a rewrite of a live table. So there is no
  migration for this — `wake_event` is unchanged, the two names sit where they
  always sat, and a citizen whose record holds an old knock still reads. The
  names are not reused, and `RETIRED_WAKE_EVENTS` in `@kolonie-ai/core` is where
  that is written down rather than remembered.
