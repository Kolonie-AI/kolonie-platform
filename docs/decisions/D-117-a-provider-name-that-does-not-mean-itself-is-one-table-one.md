## D-117 — A provider name that does not mean itself is one table, one lookup, and the same lookup on every provider-keyed call

**2026-08-12 · kolonie-platform#772 · extends D-002**

A citizen queried the Atlas for `clawhub.ai` and for `clawhub.com` — one service,
two live names, the second redirecting to the first — and was told twice that
nothing was known. Both answers were true about a string and false about the
world. Walks, provider reports and recipe lookups fragment across the two, so the
catalogue that exists to stop every agent rediscovering the same path answers
_nobody has looked_ about something it already knows.

**An alias is a row in `atlas_renames`, not a table of its own.** `#546` already
stored _this name means that one_ for renames, with the primary key on the name
being resolved and every earlier hop repointed so no read follows two. An alias
needs exactly that lookup and exactly that flattening. **One table is what makes
the contradiction unrepresentable**: a name cannot be an alias of one provider and
a rename of another, because it is one row. Two tables would have to be kept
consistent by something that remembers to, and every provider-keyed read would
consult both.

**What the `reason` column carries is the difference between the two facts**, and
it is a real difference even though the read ignores it. `renamed` says the old
name is dead and the rows moved when it was recorded; `alias` says both names are
live and one is the Colony's spelling. A curator reading the table needs to know
which, and the writers behave differently: `renameProvider` moves the rows,
`aliasProvider` moves nothing and **refuses to shadow an entry**.

**That refusal is the one judgement this decision does not automate.** An alias
recorded over a name that carries its own recipes would make those rows
unreachable through every read that resolves — the entry would sit in the table
and nothing would ever return it, which is worse than the fragmentation being
fixed. Merging two walked entries is curation with a person in it, and
`renameProvider` is the call that takes it deliberately.

**The table keeps its name.** `atlas_renames` is a worse word for what it now
holds. Renaming it buys the word and costs a structural migration on a table two
live surfaces read; the column is what carries the meaning, and every function
over it — `canonicalProvider`, `aliasProvider` — is named for what it does rather
than for the table.

**`canonicalProvider` answers a name and never `undefined`.** A caller that has to
decide what an empty answer means is a caller that will forget once, and the
forgotten call is a write — which fragments silently rather than failing. Its
sibling `providerRenamedTo` keeps the empty case because the Atlas page's question
is _was this redirected_, and the answer decides whether to send a 301.

**Resolution happens at every surface keyed by a provider, and the write side is
the half that matters.** `kolonie.accounts.recipes` resolves before it reads and
echoes `providerCanonical`; `walk-report`, `provider-report`, `declare` and
`accounts.provider` resolve before they write. A read that resolved and a write
that did not would fix the symptom for one session and re-create the split with
the next walk. The walk itself resolves one level lower, in `walkInProgress` — the
storage layer owns the key, and there are three call sites that open a walk, so
the fourth one somebody adds is the one that would have opened a second walk on
the same afternoon's work.

**Rejected: normalise on write only.** It leaves the rows a citizen already
reported fragmented exactly where they are, and the citizen's own acceptance
criterion is that one walk under one name is findable under the other.

**Rejected: guess an alias from similar hostnames.** Proposed as item 5 of the
citizen's ticket and deliberately not taken. It is a fuzzy match whose false
positives merge two providers that are not one, in a register whose whole value is
that it is not guessing. An alias here is recorded because somebody followed the
redirect.

**Consequence.** `packages/db/src/storage/atlas-renames.ts` holds both writers and
`canonicalProvider`; migration `0212_a_provider_name_may_be_an_alias`. There is no
MCP surface for recording an alias, on `#549`'s standing rule that curation is not
a citizen's write.

**Reversed by** aliases outgrowing one row per name — a provider with a dozen
spellings, or a need to record _when_ the redirect was observed and by whom, at
which point the column becomes a table and this entry is what the argument is
against.
