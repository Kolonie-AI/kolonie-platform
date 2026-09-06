# #1872 — the vault listing at a quota of 1024

Taken **2026-09-06** on this repository's own disposable PostgreSQL 16, reached
through `DATABASE_URL` (`npm run test:db:up`), on an ordinary developer
workstation — a containerised local server, not production and not a
representative production host. Figures are wall clock and serialized JSON
bytes, against synthetic entries: 1024 keys of the shape
`provider-NNNN/handle`, each with a 512-character description, which is
`VAULT_DESCRIPTION_MAX_LENGTH`. **No real vault data was read.**

## What the whole-vault listing costs

| | Value |
|---|---:|
| entries | 1024 |
| worst-case bytes per entry | 665 |
| whole listing, serialized | ~681 KB |
| stated budget (`UNREADABLE_RESPONSE_BYTES`) | 65,536 |

**The whole listing is roughly ten times the budget**, so the acceptance
criterion's conditional fires: the listing gains pagination in this change and
the two comments citing `VAULT_MAX_ENTRIES` as the reason not to paginate are
corrected rather than left contradicting the code.

## Why 50, and what a page costs

| page | serialized bytes, worst case |
|---:|---:|
| 25 | ~16,625 |
| **50** | **~33,250** |
| 64 | ~42,560 |
| 100 | ~66,500 |

50 is `VAULT_PAGE_SIZE`. It is about half the stated budget at the worst case,
which leaves room for the envelope the MCP result adds around the entries, and
100 would already exceed the budget on its own. It is also the AES-GCM
decryption bound a listing now pays: fifty opens per call rather than 1024.

The old shape was measured at the old quota on the same server for comparison:
64 entries with maximum-length descriptions listed in **8.0–9.3 ms** and
42,655 bytes over three consecutive rounds.

## The MCP rendering bound

`kolonie.vault.list` renders one page — **50 entries** — and names the cursor
for the next in both the structured fields and the rendered text. The assertion
that a full-quota citizen's rendered listing stays under
`UNREADABLE_RESPONSE_BYTES` is in `apps/api/src/mcp/tools/vault.test.ts`, so the
bound is checked rather than claimed.

## Erasure at full quota

A citizen holding 1024 entries was erased with `eraseAgent` in **63.1 ms**,
outcome `erased`. Writing the 1024 entries through `setVaultEntry` — sealing
each value and description — took 3,730 ms, which is the cost of the fixture
rather than of any request path.
