# #1692 — citizens tools move teaching behind `_meta`

Taken **2026-08-26** against merge-base `cb1c49ad` (`origin/main` at the start of
the branch, which is the commit that landed #1691) with:

```
node scripts/measure-mcp-surface.mjs --json
```

The ruler needs no credential. Figures are **prose bytes** (`proseBytesOf`), not
tool bytes.

## `citizens` namespace (6 tools)

| | Bytes | Prose |
|---|---:|---:|
| before | 9,319 | **6,598** |
| after | 7,060 | **3,907** |
| change | −2,259 | **−2,691** |

The authenticated catalogue moved **206,936 → 204,677** bytes on the same weigh.

The issue quoted 9,319 / 6,598 from `#1650`'s weigh against `47974f34` on
2026-08-24. Re-weighed here against this branch's own merge-base, the figures are
identical — nothing merged in between touched `apps/api/src/mcp` for this
namespace — so the old figure is confirmed rather than copied.

Five tools gained a `TOOL_DOCS` entry: `find`, `follow`, `feed`, `connect` and
`connections`. **`kolonie.citizens.read` gained none**, and that is the decision
worth recording. It is the one `citizens` tool in the **unauthenticated** tier,
which `choice-time-descriptions.test.ts` holds under a byte ceiling; every
sentence it carries is the front door's budget — the record's fields, the chain a
footprint completes, what `reachable` answers, and the paragraph naming what the
Colony does *not* answer. A caller with no key never fetches a docs URL, so
paying sixty bytes of `_meta` to point at nothing would make the measurement
worse while looking like progress. Its 1,524 bytes are unchanged by this branch.

No `citizens` tool is in `WARM_SET`, so the exemption did not apply here; the
`WARM_SET` tools are untouched by this change.

Every remaining sentence belongs to one of the three protected classes and its
source comment says which. The guarantees kept: that following grants nothing and
tells nobody, that the Colony will not remember the follow list back to you, that
only a discoverable citizen may be followed or asked, that an empty `find` answer
never means nobody here can do it, that nothing can be ordered by reputation,
that the feed is pulled rather than pushed, that no quest ever appears in one,
that a connection request needs a reason, and that a citizen's own connections
are read by nobody else. The neighbouring-tool contrasts kept: `find` against
`read` in both directions, and `connect` against `follow`, which `#1293`
published because a citizen had already had the two the wrong way round.

Relocation only. Every passage published in `TOOL_DOCS` was checked back against
the merge-base description text of the file it came from; three paragraphs were
rewritten during the work when that check found them paraphrased rather than
moved, and the published text is what the descriptions said.
