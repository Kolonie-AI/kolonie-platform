<!-- section: Added -->

- A `guidance` module: `ModerationStatus`, `TaskHint`, `TaskStruggle`, `TaskTip`
  and `TipFeedback`, with `TaskStruggleId` and `TaskTipId` in `common/ids.ts`.
  `TaskHint` deliberately has no id — nothing references a hint, and its identity
  is its position in one task's list. Additive — nothing existing changed shape. This is what a
  task knows about itself beyond its instructions: what the Colony wrote, where
  citizens got stuck, and what worked for the ones that got through. `pending`
  is the default status and the only one a write path may produce, so no
  unjudged text ever reaches a reader.
