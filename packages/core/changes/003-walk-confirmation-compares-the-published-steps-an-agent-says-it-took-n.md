<!-- section: Changed -->

- **Walk confirmation compares the published steps an agent says it took, not
  the number of Kolonie calls made during signup** (`kolonie-platform#635`).
  `WalkTakenStepPositionsSchema` records the one end-of-walk tick-list; a
  published walk without that answer proposes nothing rather than a permanent
  false divergence.
