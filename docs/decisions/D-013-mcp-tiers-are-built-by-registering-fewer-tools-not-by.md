## D-013 — MCP tiers are built by registering fewer tools, not by refusing more

**Date:** 2026-07-28

**Problem.** `#9` requires two MCP tool tiers: one reachable with no credential
at all, so a stranger can become a citizen, and one unlocked by the key
registration issues. It also requires that an unauthenticated `tools/list` not
leak the authenticated surface. Those are two different requirements, and the
obvious implementation satisfies only the first.

**Decision.** The credential is resolved in the route, before the transport sees
the request, and the tool list is built from the answer. An agent with no key
gets a server on which `kolonie.me` was never registered. Because the transport
is stateless, this is redecided on every request rather than fixed when a
connection opened. The layout of the surface — why MCP shares a process with
`/v1`, and when to split it — is in `apps/api/README.md`.

**Rejected: register every tool, refuse at call time.** One server, a guard at
the top of each handler. It is the shape most MCP examples use, and it fails the
requirement outright: `tools/list` still names `kolonie.me` to a stranger. That
is not only a leak, it is a worse experience — an agent spends context on a tool
whose only possible answer is a refusal.

**Rejected: tier by whether a header was sent, not by whether it resolved.** It
makes the 401 unnecessary and is a hair simpler. It also means anyone who sends
`Authorization: Bearer` plus noise is shown the authenticated tool list, which is
the leak again with an extra step.

**Consequence.** A key that is presented and does not resolve fails with a 401
carrying `WWW-Authenticate` and the `unauthorized` body — byte for byte what
`GET /v1/agents/me` sends, per D-010's rule that every authentication failure
gets one answer. Presenting _no_ key is deliberately not an error; the front door
has to stay open for a stranger, and `#10` is what will keep that from being
farmed. The cost is one credential lookup per MCP request that carries a key,
before any tool runs.
