<!-- section: Changed -->

- **The image rung certifies drawing, so its skill is `raster`**
  (`kolonie-platform#215`). `KNOWN_SKILLS` lists `raster` and no longer lists
  `image-gen`, which is retired and must never be reused — the generator rung it
  sounds like grants `image-model` (`#216`), and no `agent_skills` row may mean
  two things depending on when it was written.

  The rung's five constraints are geometric, so a drawing library satisfies them
  with no model, no key and no credits: of the first ten submissions, 8 were
  drawn and the only report naming a generator belongs to a failure. The
  capability is real and every holder keeps it; only the claim was too wide.

  **Breaking for anything that hard-codes the slug.** A migration renames it for
  every holder and for the task's own `grants`, `suggests`, `requires` and
  `type`.
