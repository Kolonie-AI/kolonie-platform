## D-137 — The catalogue floor gate is removed and is not to be rebuilt

**Date:** 2026-08-23

**Problem.** The `authenticated` MCP catalogue tier was held to a **floor**: the
last committed measurement, in `apps/api/src/mcp/catalogue-budget.json`, moving
down freely and up only in a commit naming
`the-catalogue-encodes-grammar-never-vocabulary` and saying what the new tools
were vocabulary-free for. `#889` wrote the rule, `#1118` gave it a caller,
`#1266` moved a branch's comparison to its merge base, `#1465` moved the ratchet
onto `main` so no author typed a number, and `#1566` made the figure travel as a
pull request once the merge queue refused a direct push.

Measured over the four days it was fully wired, from the git history of
`catalogue-budget.json`:

| Date       |     Tools |             Bytes |
| ---------- | --------: | ----------------: |
| 2026-08-18 |       112 |           194,396 |
| 2026-08-19 | 116 → 123 | 199,303 → 206,901 |
| 2026-08-20 | 119 → 121 | 210,630 → 215,752 |
| 2026-08-21 |       123 |           217,496 |
| 2026-08-22 |       123 |           221,007 |

Eight commits titled _"The catalogue floor goes up to what main measured"_ landed
on 2026-08-22 alone. **A gate that raises itself on every merge records growth
and never holds it.** The growth itself was not the problem — messaging,
connections and playbooks shipped in those days — but the mechanism bought none
of the discipline it was charged for.

What it did cost is on the record in the issues that fixed it, one failure at a
time. A wrongly resolved floor was green on the branch and red on `main` for
everybody (`#1379`, `#1456`). When the queue ruleset went on, the job's push
started being refused and failed on **ten consecutive merges with nobody
watching**; the floor read 121 against a served catalogue of 123, and because it
was a required check every queued entry then failed on tools it had not added —
`#1561` entered the queue five times and was evicted four (`#1566`). `#1587`
then found that the fallback verdict did not satisfy the required check at all,
and `#1594` that a force-push restarted the race it was trying to win. A local
run could refuse a branch for doing exactly what the raise procedure told it to
do (`#1483`). And every new tool meant a justification sentence plus a floor pull
request plus a queue round trip — a standing disincentive to ship one.

**Decision (operator, 2026-08-23).** The floor gate is **removed**, and **no size
gate is to be reintroduced in any form** — no hard ceiling, no per-namespace
budget, no raise-approval process — without a maintainer decision reversing this
one.

Deleted: `apps/api/src/mcp/catalogue-budget.{ts,test.ts,json}`,
`scripts/check-catalogue-floor.{mjs,test.ts}`,
`scripts/check-catalogue-budget.mjs`,
`.github/actions/catalogue-floor-pr-text/`, the `check:catalogue-floor` and
`catalogue-budget` entries in `package.json`, and from
`.github/workflows/mcp-surface.yml` the floor verdict, the failure step, the
`automation/catalogue-floor` branch and its pull request, along with the
`contents: write` and `actions: write` grants they needed.

**The ruler stays and the discipline stays.** `scripts/measure-mcp-catalogue.mjs`
weighs the catalogue per namespace on demand; `scripts/measure-mcp-surface.mjs`
and the `MCP surface` workflow still report every tier on every pull request as a
comment that fails nothing and adds no status check. The description **writing**
standard in `AGENTS.md` §3 — one statement per fact, enumerations as pairs,
reasons in source comments, guarantees stay published — is unchanged. Only the
enforcement story changes.

**Size is watched in practice.** If the catalogue gets too big, that shows up in
session cost and in agent behaviour, and it is fixed then — by shipping better
descriptions (`#1650`) and data-shaped tools (`#1652`), not by a merge blocker.

**What is lost, said plainly.** Nothing now refuses a catalogue that grows, and
the byte floor was also the second half of a pair: `defensive-prose.ts` charges a
sentence to its class whole, so a marker clause lifted out of a paragraph books
the paragraph as saved, and it was the floor that could tell that from a real
cut. `#1116` is the measured proof — its class fell 27,757 → 5,500 bytes, 22,257
booked, while only **3,543 bytes actually left the catalogue**. What answers that
now is `#1653`: the heaviest tool and the prose share, in the surface comment, as
figures a person reads. That is weaker than a check, and it is the trade this
decision makes — on the ground that a number nobody is shown is worth less than a
gate that never fired.

**Related.** `#1648` (epic), `#1649` (this change), `#1650`, `#1651`, `#1652`,
`#1653`. Supersedes D-131. D-130 removed the per-tool ceiling from the same
machinery on 2026-08-21 and its closing sentence — _"whoever wants the guard back
has the argument in `#1235` already made"_ — now applies to the floor as well.
