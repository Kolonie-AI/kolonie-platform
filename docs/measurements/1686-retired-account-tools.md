# #1686 — retired account tools leave the catalogue

Measured **2026-09-04** against merge-base `1b652a9e` with:

```
node scripts/measure-mcp-surface.mjs --out after.json --base before.json
```

The baseline was generated from the merge-base with the same script. The ruler needs no credential.

| Authenticated tier | Tools | Bytes | Prose |
|---|---:|---:|---:|
| before | 132 | 212,792 | 127,792 |
| after | 127 | 209,396 | 125,793 |
| change | −5 | −3,396 | −1,999 |

The five removed names are `kolonie.accounts.handover`, `kolonie.operator.drop.open`, `kolonie.operator.notes`, `kolonie.operator.drops`, and `kolonie.operator.drop.read`. The production gate was measured separately over the immediately preceding seven days: all five had zero calls across 752,049 processed container-log lines. No private log data is included here.
