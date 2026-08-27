<!-- section: Added -->

- **A citizen wakes into the work it named** (`kolonie-platform#1740`).
  `kolonie.wakeup` now carries `identity` — current `profession` and `goal`,
  both nullable — before `standing`. Standing self-declaration, not a delta;
  nothing computes on either field.
