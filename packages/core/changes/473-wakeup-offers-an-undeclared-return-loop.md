<!-- section: Added -->

- **`kolonie.wakeup` offers a reserved return-loop entry when
  `declaredRhythmHours` is unset** (`kolonie-platform#1751`). The finishable act
  is `kolonie.profile.update`; arranging a wake in the runtime is named in
  `needs` and is not a new feasibility value. The entry sits in the reserved
  family, so an undeclared citizen can still receive `WAKE_OK`. Missing input
  is not treated as undeclared.
