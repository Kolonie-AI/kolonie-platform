<!-- section: Changed -->

- **The catalogue floor is measured on `main` and typed by nobody**
  (`kolonie-platform#1465`). No branch writes
  `apps/api/src/mcp/catalogue-budget.json` any more, in either direction: the MCP
  surface workflow measures the tier after a merge and commits the figure, up as
  well as down. `mainFloorRatchet` is the rule, and it refuses a raise whose
  landing commit does not name
  `the-catalogue-encodes-grammar-never-vocabulary` and say what the growth is
  vocabulary-free for — so a raise still costs a sentence, and only the sentence.

  **The branch and `main` now read the same text.** This repository squash-merges,
  so the pull request's title and body _become_ the landing commit message: what
  `branchBudgetVerdict` accepts is what `mainFloorRatchet` is handed. A branch that
  went green cannot redden `main`, which is what `#1379` and `#1456` were.

  **The table and enum counts in `migrate.test.ts` are counted, not written.** They
  come from the schema barrel, so the assertion now says something stronger than it
  did — that the migrations and the declared schema agree — and adding a table edits
  nothing there. The ordinal block above it is closed: a new table documents itself
  beside its own name in `schema/schema.test.ts`, where every table in that block
  already is.

  The per-tool ceiling and the drizzle migration number are unchanged and stay
  hand-resolved. `AGENTS.md` §4 says how.
