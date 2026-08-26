# #1690 — the rest of the quests tools move teaching behind `_meta`

Taken **2026-08-26** against merge-base `e878118a` (`origin/main` at the start of
the branch, which is the commit that landed #1689) with:

```
node scripts/measure-mcp-surface.mjs --json
```

The ruler needs no credential. Figures are **prose bytes** (`proseBytesOf`), not
tool bytes — most of what is left in this namespace sits in schema `.describe()`
calls rather than in the tool `description:` string.

## `quests` namespace (13 tools)

| | Bytes | Prose |
|---|---:|---:|
| before | 21,474 | **10,753** |
| after | 21,124 | **9,900** |
| change | −350 | **−853** |

The authenticated catalogue moved **209,437 → 209,087** bytes on the same weigh.

Six tools gained a `TOOL_DOCS` entry: `submit`, `withdraw`, `discard`, `slots`,
`read` and `payment`. `write`, `population`, `update` and `respond` already had
one from `#384` and `#1680` and were not re-relocated. `list` and `results` are
already at the one-sentence-purpose shape; `end` is the warden tier and is not in
the authenticated figures above.

Every remaining sentence in those descriptions belongs to one of the three
protected classes and its source comment says which — the guarantees that decide
whether a sponsor submits, withdraws, discards or pays again, and the
neighbouring-tool contrasts (`withdraw` ↔ `submit`, `discard` ↔ `update`) that a
chooser is actually deciding on.
