<!-- section: Added -->

- **A duty a role owes is served beside the citizen's one line, not inside the
  rank** (`kolonie-platform#646`). `ROLE_DUTY_HINTS` and `chooseRoleDuty` in
  `hint/standing.ts`. `quests-awaiting-review` **leaves `STANDING_HINT_RANK`**
  and is served through the new channel instead: it claims no slot, so it
  neither displaces nor spends the line about the citizen's own record, and it
  repeats for as long as the duty stands. `StandingHintCode` is unchanged and so
  is the sentence. Measured failing 2026-08-09 — two conditions above it stay
  true until a citizen files reports nothing obliges it to file, so _below_ meant
  _never_.
