# #1689 — tasks tools move teaching behind `_meta`

Taken **2026-08-25** against merge-base `e3ce9727` (`origin/main` at the start of
the branch) with:

```
node scripts/measure-mcp-surface.mjs --json
```

The ruler needs no credential. Figures are **prose bytes** (`proseBytesOf`), not
tool bytes.

## `tasks` namespace (13 tools)

| | Bytes | Prose |
|---|---:|---:|
| before | 21,540 | **14,155** |
| after | 19,784 | **11,726** |
| change | −1,756 | **−2,429** |

The authenticated catalogue moved **211,193 → 209,437** bytes on the same
weigh. `WARM_SET` tools (`list`, `get`, `frontier`, `submit`, `report`) keep
their exemption; only teaching that is not a neighbouring-tool contrast or a
call-time guarantee left the published descriptions.
