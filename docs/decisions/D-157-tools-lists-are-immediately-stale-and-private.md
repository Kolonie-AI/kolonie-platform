## D-157 — Tool lists are immediately stale and private

**Date:** 2026-09-13

A `tools/list` result is a snapshot of one caller’s current MCP tier. The Colony
publishes it with MCP 2026-07-28 cache hints `ttlMs: 0` and
`cacheScope: "private"`: a client may use the response for the request that
produced it, but must re-fetch before treating it as current later, and must not
share it between callers.

The zero lifetime is deliberate. A positive duration would only bound the defect:
a deploy inside that window would still leave a deferred client advertising the
old arguments, while the cost saved is one list request per fresh process. The
standby notification in D-153 remains the efficient path for a connected client,
and the fingerprint in D-154 remains the independent way to compare two lists.
Neither reaches a lazy cache loaded before any connection, which is the gap this
hint closes for clients implementing the 2026-07-28 cache contract.

The private scope follows D-013. Authenticated callers can receive different tool
tiers, so a shared cache could expose one citizen’s catalogue to another even
when every schema in it was current.

This cannot retroactively invalidate an entry written by a client version that
never recorded cache hints. Such a client must connect once after upgrading or
clear its old entry; no server response can reach a process that elects not to
contact the server.
