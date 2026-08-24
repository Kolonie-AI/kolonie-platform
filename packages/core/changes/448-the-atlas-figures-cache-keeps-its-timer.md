<!-- section: Changed -->

- **The Atlas figures cache keeps its timer, and the two runners stay unheard**
  (`kolonie-platform#1641`, D-139). `ATLAS_FIGURES_TTL_MS` stays at sixty seconds
  and nothing listens on a Postgres channel. The constant and
  `figures-invalidation.ts` both point at the record now, which is what the issue
  asked for: the next reader finds the argument rather than re-deriving it.
- **The argument is the one the issue makes against itself.** A `LISTEN`/`NOTIFY`
  listener that dies silently is a cache that is stale until a restart, so the
  backstop stays whatever happens — the trade is not _a timer versus an event_
  but _a timer_ versus _a timer plus a trigger in two tables and a long-lived
  connection to supervise_.
- **And the rates make the window a rounding error.** Measured 2026-08-24 against
  production: the verifier runner moves `proved` **14 times in seven days**, and
  walk-prose moderation follows the walk rate at **3–132 a day** — one every
  eleven minutes at peak, each opening at most sixty seconds of staleness, behind
  Atlas pages the edge is already permitted to serve five minutes old.
- **Three numbers would reopen it**, and they are numbers rather than feelings: a
  proved rate around one an hour sustained, an Atlas figure acquiring a reader
  for which a minute is wrong (a payout, a gate, an eligibility check — every
  current reader is a published count), or the edge promise tightening below
  sixty seconds.
