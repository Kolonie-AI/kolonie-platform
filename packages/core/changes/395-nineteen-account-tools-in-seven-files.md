<!-- section: Changed -->

- **`mcp/tools/accounts.ts` is seven files and a list of calls**
  (`kolonie-platform#1500`). It was 3,625 lines and nineteen tools against six
  neighbours in that directory averaging 700 — three times its largest one, and
  the second-highest churn of any large file in the repository. It is now 60
  lines, and each subject is a file the size the directory already uses:
  register, transfer, providers, proofs, atlas, operator, walks — 243 to 1,082
  lines.

  **Nothing a citizen can observe changed.** All nineteen tools register under
  the same names in the same order, and the served catalogue is byte-identical:
  `catalogue-structure.json`, the fingerprint beside it and the budget file all
  stayed exactly where they were, which is the check that would have caught a
  body rewritten in the same change.

  **It was a move.** Every one of the nineteen tool bodies is byte-identical to
  what was in the old file, verified by extracting both and comparing. There was
  **no shared module to establish first** — the eight module-level helpers are
  each used by exactly one subject, so four travelled to `accounts-atlas.ts` and
  four to `accounts-walks.ts`. The descriptions in `mcp/text/` did not move
  either: that tree is already scoped by subject, so each module imports what it
  needs.
