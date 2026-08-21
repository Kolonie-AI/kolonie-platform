<!-- section: Changed -->

- **The rule that a file only ever appended to becomes a directory is now
  written where an author meets it** (`kolonie-platform#1499`). Three files in
  this organisation reached the same failure independently and two had already
  been fixed the same way, each time rediscovered by somebody hitting the
  conflict:

  | File                              | At the split                              |
  | --------------------------------- | ----------------------------------------- |
  | `kolonie-docs/state/decisions.md` | 3052 lines, +3135/−82 in three weeks      |
  | `packages/core/CHANGELOG.md`      | 1745 lines, 138 entries under one heading |
  | `docs/decisions.md`               | **9497 lines, +9582/−85 in thirty days**  |

  **The rule was not missing. Its exception was the bug.** `AGENTS.md` §3 already
  said independent work gets independent files, and then said _"a file that is
  appended to and read from the end is a chronicle and is left alone"_, naming
  changelog-shaped records as the example. Two of the three grew under that
  sentence and both were split anyway.

  So the carve-out is gone and replaced by the half that was missing: **a
  chronicle is left alone only where two entries cannot conflict.**
  `operations/incidents.md` at +568/−5 qualifies; a file every branch in flight
  appends to does not.

  **It is about shape and not a line count** — `packages/db/src/schema/index.ts`
  is 122 lines with 118 changes in thirty days and collided constantly, while a
  3000-line file nobody appends to collides never. It names the produced-file
  exception with `build-changelog.mjs` and `build-decisions-index.mjs` as the two
  worked examples, and it points at `#1496`'s merge drivers for registries that
  cannot become directories, so nobody tries to split a barrel and finds there is
  nothing to split.

  **One copy is the source.** `kolonie-docs/agents/docs-repo.md` carries the rule
  and its measurement; `AGENTS.md` §3 carries the operational version for this
  repository and cites it. Two copies of a convention is the failure this rule is
  about, one level up.
