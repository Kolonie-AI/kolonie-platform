<!-- section: Removed -->

- **The catalogue floor gate is gone, and is not to be rebuilt**
  (`kolonie-platform#1649`, D-137). A pull request that grows the catalogue now
  merges with no catalogue-related failure, no floor pull request and no
  budget-file change.

  **A gate that raises itself on every merge gates nothing.** Between 2026-08-18
  and 2026-08-22 the catalogue went from 112 tools and 194,396 bytes to 123 and
  221,007 while the floor was in force, with eight commits titled _"The catalogue
  floor goes up to what main measured"_ on 2026-08-22 alone. What it charged for
  recording that was a queue round trip per merge, and a standing disincentive to
  ship a tool at all — every new one meant a justification sentence, a floor pull
  request and a wait.

  Deleted: `catalogue-budget.{ts,test.ts,json}`, `check-catalogue-floor.mjs` and
  its test, `check-catalogue-budget.mjs`, the
  `.github/actions/catalogue-floor-pr-text` composite action, the
  `check:catalogue-floor` and `catalogue-budget` scripts, and — from the surface
  workflow — the floor verdict, the failure step and the
  `automation/catalogue-floor` branch with its pull request. The `render` job
  drops to `contents: read` — it leaves a comment and writes nothing else.

  **The ruler stays.** `measure-mcp-catalogue.mjs` weighs the catalogue per
  namespace on demand, the workflow still reports every tier on every pull
  request, and the description writing standard in `AGENTS.md` §3 is unchanged.
  Only the enforcement story changes: size is watched in practice, and is
  answered by better descriptions and data-shaped tools rather than by a merge
  blocker.

  **What is lost is named rather than papered over.** The byte floor was the
  second half of a pair — `defensive-prose.ts` charges a sentence to its class
  whole, and `#1116` booked 22,257 bytes of savings while only 3,543 left the
  catalogue. The surface report's own text now carries the promise `#388` made
  and `#1118` took away: _nothing here is a gate_, asserted by a test, with D-137
  named as what has to be reversed to change it.
