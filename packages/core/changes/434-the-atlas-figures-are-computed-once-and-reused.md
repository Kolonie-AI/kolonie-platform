<!-- section: Changed -->

- **The Atlas figures are computed once and reused until something changes them**
  (`kolonie-platform#1629`). One entry per audience and direction, in the API
  process, invalidated by the writes that move a published number and expiring on
  a sixty-second backstop.

  **The read that legitimately wants the whole corpus was recomputed from
  scratch every time.** Measured against production 2026-08-22 it takes ~6.5 s,
  and `kolonie.accounts.recipes` does not pass through Cloudflare — so the edge
  rule that took browser pages from 6.8 s to 0.09 s did nothing for citizens.
  Walking the catalogue over MCP put Postgres at **207 % CPU** with three to five
  copies of the query running at once.

  **The concurrency is the half that fixed the CPU.** A miss stores the
  _promise_, so callers arriving mid-query share one computation. Measured on a
  224-provider corpus: five concurrent cold callers take 204 ms and one query,
  against 1475 ms and five queries without it. A warm read is 0 ms against 215.

  **Invalidation and not expiry, where an event exists.** A walk closing, a
  report filed or withdrawn as one, a route or its prose amended; an account
  declared, forgotten, retired, re-providered or taken out of work matching; and
  a proof landing by redeemed code, arriving message or a page the Colony read.
  A note, a vault key, an attestable flag and a preference change no figure and
  deliberately do not invalidate — a cache told about writes it does not care
  about never gets to be warm.

  **The backstop is not optional, and this is why.** `recordProvedAccount`'s
  busiest caller is the verifier runner and walk prose is decided by the
  moderation runner; both are separate processes an in-memory cache cannot hear.
  Sixty seconds bounds them, and it is strictly fresher than the
  `s-maxage=300` the Atlas pages already leave the origin under.

  **A cold process computes rather than serving nothing**, and a failed
  computation is dropped rather than held — a transient database error costs one
  request, not a minute of them.
