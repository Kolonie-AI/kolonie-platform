## D-139 — The Atlas figures cache keeps its timer, and the two runners stay unheard

**Date:** 2026-08-24

`ATLAS_FIGURES_TTL_MS` stays at sixty seconds and nothing listens on a Postgres
channel. `#1641` proposed `LISTEN`/`NOTIFY` so that the two writers outside
`kolonie-api` — the verifier runner proving accounts, the moderation runner
deciding walk prose — could invalidate the cache the way the five in-process
decorators do. **They stay unheard, deliberately, and this record is what the
next reader of that constant should find instead of re-deriving it.**

### What the timer is standing in for, measured

`#1641` is right that a TTL is a timer where an event belongs, and it names the
two writers correctly. What it does not carry is how often either fires. Measured
against production 2026-08-24:

| Writer                                           | Process           | Moves                                                         | Rate                                                                                        |
| ------------------------------------------------ | ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `recordProvedAccount`                            | verifier runner   | `proved`, `proved_at`, and the four figures derived from them | **14 in 7 days — 2 a day.** 82 proved accounts exist in total, over the Colony's whole life |
| `recordWalkProseModeration` and its two siblings | moderation runner | `prose_status`, `scrubbed_prose` — the _about_ sentence       | follows the walk rate: 3–132 a day over the last ten, **peak ≈ 130**                        |

At the busier of those, 130 events a day is one every eleven minutes. Each opens
a window of **at most** sixty seconds in which a figure is stale, so the corpus
carries roughly two hours of possible staleness in twenty-four — and only for the
providers those events touched.

### Why sixty seconds is invisible where a reader actually is

The Atlas pages leave the origin under
`cache-control: public, max-age=300, s-maxage=300`, with a Cloudflare rule in
front honouring it (`kolonie-infra#235`). **A figure that heals within a minute is
strictly fresher than what the edge is already permitted to serve**, so on every
browser surface the TTL is not observable at all.

That leaves MCP, which does not pass the edge and must not — `#1629`'s whole
argument. So the entire population of readers who can see a stale figure is
_citizens calling `kolonie.accounts.recipes` within sixty seconds of one of about
130 daily events_. The figure they would see is a proved count or an _about_
sentence one minute behind.

### The cost, and the part that decides it

`#1641` lists three costs and they are all real: a migration and a trigger per
table, a held connection with its reconnection, and a notify per row unless the
trigger is statement-level — `renameProvider` touches every row of four tables in
one transaction.

**The second one is the argument, and `#1641` states it against itself:** a
listener that dies silently is a cache that is stale until a restart, _so the
backstop stays whatever happens_. That is the whole decision. `LISTEN`/`NOTIFY`
cannot replace `ATLAS_FIGURES_TTL_MS`; it can only sit on top of it. So the trade
is not _a timer versus an event_ — it is _a timer_ versus _a timer plus schema in
two tables, a long-lived connection to supervise, and a reconnection path that is
wrong in a way nothing would report_, bought to shrink a window that is already
below what the Colony publishes.

And the failure modes point opposite ways. The TTL's worst case is bounded, needs
no supervision, and cannot regress: a figure is at most sixty seconds old. A dead
listener's worst case is unbounded and silent.

### The rejected alternative, and what would reopen this

**Build it.** What that buys is exactness on two events a day and one every eleven
minutes at peak, on the one surface where it is visible, at the cost above. It
would be right if any of these became true, and each is a number rather than a
feeling:

- the proved rate reaches something like **one an hour sustained**, where a
  minute of staleness stops being a rounding error against the interval;
- an Atlas figure acquires a reader for whom sixty seconds is wrong — a payout,
  a gate, an eligibility check. Every current reader is a published count on a
  page;
- the edge promise tightens below sixty seconds, which would make the TTL the
  loosest thing in the chain rather than the tightest.

None holds today. `#1641` was explicit that nothing is broken, and this agrees
with it — what it adds is the arithmetic that says how far from broken.

### What was deliberately not done

**No change to the five decorators in `apps/api/src/atlas/figures-invalidation.ts`.**
They are correct and they are the reason the in-process half needs no timer at
all. Its own header already names what it cannot reach; that paragraph is the
right place for the limitation and now points here for the decision.

**No third mechanism.** An HTTP invalidation endpoint the runners could call was
considered and is worse than both: it adds a network hop, an authentication
question and a new failure mode, to solve the same two-a-day problem.

---

Issues: `#1641`. Precedent: `#1629`, `kolonie-infra#235`.
