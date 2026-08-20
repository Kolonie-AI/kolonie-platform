## D-006 — Timestamps are ISO strings, not `Date`

**Date:** 2026-07-26

**Decision.** `Timestamp = string`, validated as ISO 8601 UTC.

**Rejected: `Date`.** It does not survive JSON serialisation. Every consumer —
Postgres via the backend, React via the frontend, verifier modules in the
academy — would deserialise it slightly differently, and the type would be
lying about what actually crosses the wire.
