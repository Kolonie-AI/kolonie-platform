# #1693 — vault tools move teaching behind `_meta`

Taken **2026-08-26** against merge-base `3139fcd8` (`origin/main` after the
rebase that followed #1713 landing) with:

```
node scripts/measure-mcp-surface.mjs --json
```

The ruler needs no credential. Figures are **prose bytes** (`proseBytesOf`), not
tool bytes.

## `vault` namespace (7 tools)

| | Bytes | Prose |
|---|---:|---:|
| before | 9,702 | **6,525** |
| after | 6,784 | **3,048** |
| change | −2,918 | **−3,477** |

The authenticated catalogue moved **204,627 → 201,709** bytes on the same weigh.

The issue quoted 9,702 / 6,525 from `#1650`'s weigh against `47974f34` on
2026-08-24. Re-weighed here against this branch's own merge-base, the namespace
figures are identical — nothing merged in between touched this namespace's
descriptions — so the old figure is confirmed rather than copied. The **catalogue**
total is not: it was 206,936 against `cb1c49ad`, where this branch first sat, and
#1713 took it to 204,627 before this one rebased onto it. That is exactly the trap
`#1650` recorded, and the figures above are the merge-base this branch actually
has.

All seven tools gained a `TOOL_DOCS` entry: `set`, `get`, `list`, `describe`,
`delete`, `share` and `unshare`. Every one of them carried teaching a citizen
reads after choosing; none of them is in `WARM_SET`, so the exemption did not
apply here and the `WARM_SET` tools are untouched by this change.

Every remaining sentence belongs to one of the three protected classes and its
source comment says which. This namespace is unusually dense in the third class,
because a wrong belief about a vault call costs a credential rather than a
retry. The red lines and guarantees kept: that key material never goes in, that
the Colony cannot recover an entry, that an entry only opens with the key that
stored it, that an entry whose account was given away is refused rather than
opened, that a listing carries no value, that describing an entry never reads or
writes it, that a delete is real, that sharing takes the name and never the
value, what sharing costs against the vault's own promise, that a shared entry
is handed back exactly once, and that unsharing deletes nothing. The
neighbouring-tool contrast kept is `share` naming `unshare` as the way on, which
`choice-time-descriptions.test.ts` has asserted since `#1444`.

Relocation only. Every passage published in `TOOL_DOCS` was checked back against
the merge-base description and field text of `tools/vault.ts`. Two passages read
as missing on a first automated pass because they are built from
`VAULT_SHARE_DEFAULT_DAYS` and `VAULT_SHARE_MAX_DAYS` in a template literal
rather than a plain string; both were confirmed verbatim against the source.
