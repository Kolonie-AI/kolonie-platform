<!-- section: Changed -->

- **Breaking:** `QuestDraftSchema` and `QuestPatchSchema` are now strict
  (`kolonie-platform#804`). An unknown field is refused by name rather than
  dropped, because a sponsor that invents or mistypes a gate must not be told its
  quest was written while the gate silently disappears. `mustNotHold` additionally
  points to the positive-only `requires` field and states that negative skill
  targeting does not exist.
