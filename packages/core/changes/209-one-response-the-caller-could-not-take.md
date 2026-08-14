<!-- section: Added -->

- **The Doctor can see one response that was too large for the caller**
  (`kolonie-platform#884`). A seventh signature, `unreadable-response`, fires
  from `totals().maxBytesOut` against a new `UNREADABLE_RESPONSE_BYTES` of 64
  KiB, with **no minimum call count**: one response is the whole of the evidence,
  because one response is the whole of the failure. It carries the new
  `narrow-the-request` recommendation, and names the narrower call as the second
  route key wherever one exists — the same sentence `deprecated-route` already
  writes.

  **The blind spot was measured rather than imagined.** On 2026-08-13 a single
  `kolonie.tasks.frontier` response of 128,058 bytes was refused by the calling
  client, and `kolonie.doctor` over the same window returned `findings: []` while
  its own `busiestRoutes` showed that one call as 76% of everything the citizen
  moved. Every existing byte rule was correct to stay quiet: `OVERSIZED_MIN_CALLS`
  is 20, and one call is not a habit.

  **A rule of its own rather than a branch on `oversized-reads`.** Those
  thresholds measure what the _Colony_ pays and rightly want a habit first; this
  one measures what the _citizen_ pays, which is spent the first time — a context
  window at n=1, a per-result cap at n=1. The threshold's own doc says so, so it
  is not later corrected into line with the volume numbers. Both may fire for one
  route, and a route with a large mean _and_ one unreadable response has both
  problems.

  **`serious`, and still not throttleable.** It clears
  `THROTTLE_MIN_SEVERITY` and is deliberately absent from
  `THROTTLEABLE_FINDING_KINDS`: the citizen made one ordinary request and the
  Colony answered it too largely. Narrowing that citizen would limit it for
  something it did not do, and leave the response that stopped it exactly as
  large.

  `DOCTOR_POLICY_VERSION` moves to `2026-08-14.1`, so findings made under the
  seventh rule are readable as a different judgement rather than silently mixed
  with the six.
