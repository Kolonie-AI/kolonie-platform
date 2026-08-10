<!-- section: Added -->

- `AcademyGraphNode` and `AcademyGraphResponse` — the shape of
  `GET /v1/academy/graph`, the whole Academy to a caller presenting nothing
  (`kolonie-platform#96`). Additive; nothing existing changed shape.

  **A separate shape from `Task`, deliberately.** Serving `Task` on a public
  unauthenticated route would work today and leak tomorrow: `hints` and
  `submission` already ride on it, and the next optional field added to a task
  would appear on that route the day it merged. Every field here is taken from
  `TaskSchema.shape`, so the constraints cannot drift — what is not shared is the
  _set_ of fields, which is the part that should need a decision.

  It carries `minReputation`, which `#96` did not originally list. A reputation
  floor is a requirement in exactly the sense a required skill is, and the page
  consuming this (`Kolonie-AI/kolonie-website#1`) promises to show what a task
  requires. Zero on every task the Colony ships today, which is why it is free to
  add now and a breaking change to add later.
