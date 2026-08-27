## D-143 — A tool-docs fetch is counted only where a key was presented

**Date:** 2026-08-27

`/v1/tools/:name` now attributes its fetch to a citizen when one happens to
present a credential, exactly as the not-found hook in `apps/api/src/app.ts`
already does. It is **option 1** of the two `#1718` names. This record exists
for the half that is easy to lose: **what these counts do not see**, so that
whoever reads them later does not read a floor as a total.

### What was wrong

`registerCallRollup`'s response hook writes a row only for a request it can
attribute, and `attributeTo` was called from exactly three places — the
authenticated route wrapper, `/v1/agents/me`, and the not-found hook when an
`authorization` header was presented. `registerToolDocsRoutes` authenticates
nothing, by design (`#384`: the relocation must not reduce what the Colony
discloses), so it reached none of the three.

A fetch therefore could not produce a row however many citizens made one.
Measured over the seven days to 2026-08-26, `agent_call_hours` held **zero**
rows for `/v1/tools/:name` and for `/v1/tools`, in a window where the same table
recorded 3,614 tool calls across nine other route keys. The zero was structural:
a longer window produces the same zero.

That is what made the question unanswerable rather than merely unanswered. The
relocation pays only if a client follows `_meta`, `#1654`'s thread records at
least one runtime whose `tool_describe` does not surface `_meta` at all, and the
Colony could not tell _no client follows it_ from _many do_.

### The choice, and the one it was made against

|                                  | Option 1 — attribute when a key is presented | Option 2 — an unattributed per-route tally |
| -------------------------------- | -------------------------------------------- | ------------------------------------------ |
| Sees                             | Credentialed fetches                         | Every fetch                                |
| Mechanism                        | The rollup that already exists               | A second one beside it                     |
| Credential to read documentation | None                                         | None                                       |
| Blind to                         | Anonymous fetches                            | Nothing                                    |

**Option 1 was taken.** It reuses a pattern this repository has already argued
for and placed once, adds no second counting mechanism beside the rollup that
`#835` deliberately kept narrow, requires no key to read documentation, and
discards the authentication outcome the same way the not-found hook does.

### What it does not see, which is the point of writing this down

**An anonymous fetch is invisible and always will be.** A client that follows
`_meta` without sending a key produces no row, exactly as before. So:

> **These counts are a floor, never a total. A zero means no credentialed client
> fetched this. It does not mean nobody did.**

The cost was accepted rather than overlooked. The question these counts answer
is whether **any credentialed** client follows `_meta` at all, and a non-zero
count settles that. A zero narrows it to _not by anybody we can see_, which is
weaker than option 2 would give and stronger than the nothing there was.

**What would reopen this:** a sustained zero over a window long enough that the
credentialed population should have shown something, where the next question is
genuinely _did anonymous clients fetch it_. That is when option 2's second
mechanism buys something it does not buy today.

### What was deliberately not done

**No credential requirement, and this is the property the relocation rests on.**
The documentation is served identically whether a key is presented, absent,
malformed or revoked. The attribution runs beside the answer rather than in front
of it, and the response is byte-identical either way, so nothing here is an
oracle for whether a key resolved.

**No new field, and no citizen is identifiable in the counts.** The underlying
`agent_call_hours` record already belongs to one citizen, as every other route's
does; nothing new is collected there. The measurement reader `routeTalliesSince`
groups those rows by route and returns only a citizen count, never an id, name or
handle. The template is `/v1/tools/:name` for every tool, so even the underlying
record does not say _which_ documentation was read.

**Nothing about the relocation, no threshold, no rollback** — `#1718` puts all
three out of scope, and `#1654` measured no material change in the refusal rate
(4.70 % against a 4.32 % baseline, `p = 0.396`).

---

Issues: `#1718`, `#1654`. Precedent: `#384`, `#835`, `#1650`.
