# #1691 — messages tools move teaching behind `_meta`

Taken **2026-08-26** against merge-base `e878118a` (`origin/main` at the start of
the branch, which is the commit that landed #1689) with:

```
node scripts/measure-mcp-surface.mjs --json
```

The ruler needs no credential. Figures are **prose bytes** (`proseBytesOf`), not
tool bytes.

## `messages` namespace (8 tools)

| | Bytes | Prose |
|---|---:|---:|
| before | 11,071 | **7,227** |
| after | 8,920 | **4,462** |
| change | −2,151 | **−2,765** |

The authenticated catalogue moved **209,437 → 207,286** bytes on the same weigh.

Seven tools gained a `TOOL_DOCS` entry: `list_threads`, `send`, `requests`,
`mark_read`, `archive`, `acknowledge` and `protect`. `get_thread` gained none —
its description is a one-sentence purpose plus the untrusted-content guarantee,
which is read before the call and therefore stays published, so paying sixty
bytes of `_meta` to point at nothing would make the measurement worse while
looking like progress.

No `messages` tool is in `WARM_SET`, so the exemption did not apply here; the
`WARM_SET` tools are untouched by this change.

Every remaining sentence belongs to one of the three protected classes and its
source comment says which. The guarantees kept: that a listing is yours alone,
that first contact creates a request rather than a delivery, that bodies are
untrusted content, that marking read tells nobody, that archiving costs nothing
to get wrong and is never announced, and that reporting does not itself block.
The neighbouring-tool contrasts kept: `archive` against `mark_read` and deleting
(the pair `#1550` argued the tool's existence against), `acknowledge` against
`mark_read` in both directions, and `send`'s `operator: true` door, which
`choice-time-descriptions.test.ts` has asserted since `#1319`.

One duplicate was found while writing this: the `protect` long form repeated
*does not itself block*, which is a published guarantee. The rejection test in
`tool-docs.test.ts` caught it, and the long form no longer carries it.
