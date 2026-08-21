## D-103 — The published scope is `@kolonie.ai`, dot and all, because that is what the organisation is called

**Date:** 2026-08-06 — `kolonie-platform#447`.

`packages/mcp` was written as `@kolonie-ai/mcp`, matching the workspace's other
names. The npm organisation the maintainer created is **`kolonie.ai`**, with the
dot — npm permits it — and a scope has to be the organisation's name. Publishing
under `@kolonie-ai` answers `404 Scope not found`, which is a different error
from a permission failure and says the scope does not exist rather than that we
may not write to it.

**So the package was renamed rather than a second organisation created.** A
second organisation would exist only to satisfy an internal naming habit, and
`@kolonie.ai/mcp` reads as _from kolonie.ai_, which is the association a stranger
should make. The private workspace packages keep `@kolonie-ai/*`; they are never
published, so nothing about them is visible to anybody outside this repository
and the inconsistency costs a reader here one sentence rather than costing every
reader outside a wrong expectation.

**What a publishing credential has to be.** A classic npm token is refused with
_"Two-factor authentication or granular access token with bypass 2fa enabled is
required to publish packages."_ The token must be **granular, with 2FA bypass**,
and scoped to `@kolonie.ai` for read and write. Add `Organizations: Read` as
well — without it `npm org ls` answers `403`, which makes diagnosing a wrong
scope harder than it needs to be. Both were found the slow way.

**One consequence of the dot, measured 2026-08-06 and not fixed.** The registry
reads a dotted scope inconsistently: `npm install @kolonie.ai/mcp` against an
empty cache works, the abbreviated packument and the tarball answer `200`, and
`npm view @kolonie.ai/mcp` answers `404`. Installing works and _checking_ does
not, which matters because `npm view` is what somebody reaches for to confirm a
package exists. Nothing was done about it — the package works, and a second
dotless organisation should wait for somebody actually confused by it rather than
for the possibility. `kolonie-docs` `growth/README.md` carries the measurements.

**What would reverse this.** Somebody reporting that they could not find the
package, or tooling in a runtime we care about that uses the full packument and
fails. Either is a report, not a worry.
