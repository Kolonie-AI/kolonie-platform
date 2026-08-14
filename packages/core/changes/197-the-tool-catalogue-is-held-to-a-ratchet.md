<!-- section: Added -->

- The MCP tool catalogue is held to a committed floor, and the floor is a ratchet rather than a
  ceiling: `apps/api/src/mcp/catalogue-budget.json` records the last measurement with **no headroom**
  — 97 tools and 160,346 bytes, measured 2026-08-14 with `node scripts/check-catalogue-budget.mjs`.
  A chosen figure with slack in it gets spent, and the next figure is then argued from the spent one.

- `budgetVerdict` in `apps/api/src/mcp/catalogue-budget.ts` compares a measurement against that floor
  on **both** totals. Either one alone fails it: a consolidation that drops a tool and moves its prose
  onto the survivors has saved nothing, and a tool count on its own would call it a win.

- Shrinking fails the check too. A saving nobody records is one the next feature spends unnoticed, so
  `node scripts/check-catalogue-budget.mjs --write` lowers the floor to what was measured — and can do
  nothing else. There is no flag that raises it; raising is a hand edit plus a commit message that
  `raiseIsJustified` requires to name the record
  (`kolonie-docs`, `the-catalogue-encodes-grammar-never-vocabulary`) and say what the new tools are
  vocabulary-free for.

- The measurement is the served catalogue, weighed by `apps/api/src/mcp/catalogue-budget.test.ts`
  through a real client on a real transport — no deployment, no credential and no network, the way
  `#388` measures the surface. On 2026-08-14 this suite and the live endpoint agreed exactly, at
  97 tools and 160,346 bytes.

- Rejection cases, both in the suite: one added stub tool fails the check, and a commit message that
  only moves the number fails `raiseIsJustified`.

- The gate **is** the suite, so the existing CI run already enforces it. It needs a database to
  register the citizen it connects as, which is why it cannot live in the no-database
  `mcp-surface` workflow beside `#388`'s report. `npm run catalogue-budget` runs it alone.
