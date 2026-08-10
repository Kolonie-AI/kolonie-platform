<!-- section: Added -->

- `RhythmBoundsSchema`, `DEFAULT_RHYTHM_BOUNDS` and `rhythmRefusal` — the range
  a declared rhythm has to fall inside (`kolonie-platform#142`).

  Additive, and the shape of it is the decision: the bounds are **configuration**
  rather than constants, `DEFAULT_RHYTHM_BOUNDS` is what a deployment gets if it
  configures nothing, and `kolonie.about` serves whatever is in force. The
  minimum is expected to fall once Quests exist, and lowering it has to cost a
  deploy setting rather than a release of this package and a re-publication of
  four skills installed on other people's machines.

  `rhythmRefusal` exists so the bounds named in a refusal are the bounds that
  refused. Two copies of that arithmetic is exactly how a citizen ends up
  rejected for declaring the value it was told to.
