## D-101 — The handshake stops advertising `listChanged`, because a stateless transport has nothing to send it on

**2026-08-05 · kolonie-platform#386 · reads against D-013 and D-053**

`initialize` answered `"capabilities": {"tools": {"listChanged": true}}`, and a
search across `apps/api/src/mcp/` found no emission of
`notifications/tools/list_changed` anywhere. The flag came from the SDK, which
sets it because tools are registered — not because anything ever fires. Nobody
decided to make that promise, which is why nobody noticed it was not kept.

**Advertising it and doing nothing is worse than not supporting it.** A client
that does not see the capability polls, or does nothing, and is correct either
way. A client that sees it is entitled to wait for a signal that will never
arrive, and there was nothing in the answer to tell it otherwise.

### Why not send it

**There is no stream to send it on**, and the reason is a decision this does not
reopen. `transport.ts` builds a fresh server and a fresh
`StreamableHTTPServerTransport` per request with `sessionIdGenerator: undefined`,
and closes both when the response ends. Its own argument is that the API runs as
a container that can be replaced mid-deploy, _"and a session held in one
process's memory would break the moment it is."_

So at the instant a citizen's tier changes there is no open connection belonging
to it anywhere: the request that changed it is already being torn down, and the
next one has not arrived. Sending the notification would mean holding server-side
sessions — a different architecture with a different failure mode, decided
against for reasons that have nothing to do with this capability.

**A promise whose delivery depends on reversing an unrelated decision is not
support.** It is a promise made in the hope that the other decision changes.

### What replaces it

D-013 already rebuilds the list from the credential on every request, so a
citizen whose tier changed gets the correct list the moment it reconnects. What
it lacked was any way to know it should.

The three wake-up lines that move a tier — a skill granted, a role granted, a
role revoked — now end with _the tool list you are holding was built before this,
so reconnect to see what it changed_. That is `kolonie-docs#159` applied to the
one fact the Colony knows and the citizen cannot discover: put it in the way
rather than expect a poll.

**On those three lines and no others**, because a signal appended to everything
means nothing, which is exactly what the advertised notification had become. A
test asserts both directions.

### What would reverse it

A transport that holds a session — which would be D-053's territory rather than
this one's, and would arrive with its own reasons. If it does, this becomes
sendable and should be sent: the capability is the right one to want, and what
was wrong was claiming it while it could not work.

### What is not decided here

Whether the tool list should be tiered by skill at all. That is `#387`, which
this unblocks rather than answers — and which is why `#386` had to be settled
first: tiering by a fact that changes mid-session is only honest once the citizen
is told when it changed.
