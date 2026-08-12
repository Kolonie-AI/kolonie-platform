<!-- section: Added -->

- **The Colony judges its own Atlas proposals** (`kolonie-platform#812`).
  `AtlasModerationStagesSchema` records what decided one — the dedup query, the
  red line, each of the three admission questions in its own vocabulary, and the
  shelf — and `noAtlasStagesRun` is what a judgement starts from. The criteria
  are `ATLAS_ADMISSION_QUESTIONS`, unchanged and unparaphrased, so a refusal
  carries the same written sentence a proposer was always shown.
