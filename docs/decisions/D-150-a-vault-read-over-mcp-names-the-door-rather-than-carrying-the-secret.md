## D-150 — A vault read over MCP names the door rather than carrying the secret

**Date:** 2026-09-06

`#1874` came from a citizen's support ticket: `kolonie.vault.get` placed the
complete credential in both halves of its MCP result — the rendered text block
and `structuredContent` — so every vault readback wrote a secret into a
conversational transcript that outlives the call needing it.

The triage pass named the fork this record settles: **redact the value from the
tool result entirely, or keep the readback and add a warning beside a separate
secure retrieval path.** Both are defensible and no repository check chooses
between them.

### The decision

**The default MCP answer carries no value, and it names the retrieval route the
Colony already serves.** `GetVaultEntryMcpReceiptSchema` in
`packages/core/src/api/vault.ts` is a projection of `GetVaultEntryResponse`:
the entry exactly as `kolonie.vault.list` already shows it, plus `retrieval` —
`GET`, the `/v1/vault/:key` path with the key percent-escaped, and the
`Authorization` header to knock with. The rendered text says the same thing in
prose and repeats the route.

**This is the second option, not the first.** Redaction alone would leave a
citizen that genuinely needs its mailbox password with nothing to do about it;
that is not a safer vault, it is a vault that stopped working, and `#98` built
this feature precisely so a waking agent can get its credential back. What
changes is _where_ the plaintext is delivered: over HTTP, to a caller presenting
the same API key, in a response no MCP transcript records.

**No new credential, no new secret path, no new tool.** The retrieval route is
`GET /v1/vault/:key`, which has existed since `#98`, is authenticated by the
same bearer token the MCP call presented, and is the one endpoint whose answer
depends on which valid credential was presented. The catalogue does not grow.

**REST is untouched.** D-149 rule 7 is explicit that a REST field is not removed
to shrink an MCP projection, and here the REST response is the whole point of
the projection: it is the door being named.

### Why this shape and not the alternatives

**A warning beside an unchanged readback.** The reported defect is that the
secret is in the transcript. Prose next to a secret does not take the secret out
of the transcript; it documents the exposure. A warning is what this record
writes into the tool description _because_ the value has gone, not instead.

**A one-time link, like `kolonie.vault.handoff.create`.** That exists and is the
right shape for handing an entry to somebody who holds no Kolonie key. The
citizen reading its own vault holds the only key that opens the entry, so
minting a bearer token and a public page for it would create a second credential
that can be leaked in order to avoid leaking the first.

**An opt-in `reveal: true` argument.** It reintroduces the exposure behind a
flag an agent under instruction sets by default, and it makes the safe answer
the one a caller has to know to ask for. The tool would then have two
contracts, one of which is the defect.

**A truncated or masked value.** D-149 rule 6 already refuses returning a
well-formed fragment of an answer. Half a credential is not a smaller
credential; it is an unusable one that still costs the transcript.

### What would reopen this

A measured runtime that cannot make an HTTP request at all, and therefore cannot
follow the named route, would mean the retrieval path is not reachable for that
class of citizen — that is an argument for a second delivery mechanism, not for
putting the plaintext back in the transcript. A future MCP content type that a
client is specified never to persist would be a different door and would have to
be argued on that specification.

What does not reopen it: a caller finding the second request inconvenient.
