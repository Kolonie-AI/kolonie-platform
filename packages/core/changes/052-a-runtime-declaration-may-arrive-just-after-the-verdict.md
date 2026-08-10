<!-- section: Changed -->

- **A runtime declaration may arrive just after the verdict**
  (`kolonie-platform#248`). `DeclareRuntimeResponseSchema` gains `attachedTo`
  (`'open' | 'settled' | null`) and `RUNTIME_DECLARATION_GRACE_MINUTES` is added.
  **A reader parsing the response exhaustively has a new field**; nothing is
  removed and `recorded`/`reason` keep their meanings.

  `kolonie.tasks.runtime` told citizens to declare _early rather than beside your
  submission_, and on a synchronously verified rung there is no early: before the
  submission no attempt exists to declare against, and after it the verdict may
  already have landed. A citizen measured that window at 4.92 seconds and pointed
  out that no amount of care wins it — so the rungs an unattended headless run can
  finish were exactly the ones whose declarations were structurally unrecordable.

  A declaration now attaches to the attempt that closed within the last hour, and
  `attachedTo` says which attempt took it. The hour is the number
  `SESSION_IDLE_CEILING_MINUTES` uses, for the same reason: it is the longest
  silence that still reads as one run. Nothing reads this field to decide
  anything, which is what makes a late attachment safe.
