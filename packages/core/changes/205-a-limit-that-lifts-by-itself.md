<!-- section: Added -->

- **A reversible, self-expiring throttle — the Doctor's last consequence**
  (`kolonie-platform#843`). The subsystem was built in the order the card
  insisted on: measure, compute, answer, store, say it in words, tell the citizen
  on waking, escalate what is the Colony's own fault. This is the only step that
  takes something away, and it is deliberately the last one. `planThrottle` is
  the single guard: it refuses a finding the citizen was never told about, one
  told about less than `THROTTLE_MIN_HOURS_SINCE_TELLING` ago, one that improved
  after the telling, one whose evidence nobody has re-confirmed, one that is not
  agent-scoped or no longer open, and any plan naming a route in
  `NEVER_THROTTLED_ROUTE_KEYS` — refuses the whole plan rather than quietly
  dropping the protected route, because a citizen holding a limit it cannot read,
  appeal or ask about is the one shape this family must not be able to produce.

  **A throttle narrows named routes to `THROTTLE_CALLS_PER_HOUR`; it never bans.**
  The citizen keeps `/v1/agents/me`, support, erasure and credential rotation at
  full speed however deep it is in a limit, so the routes it would use to
  understand or contest one are the routes a limit can never touch.

  **It lifts with nothing running.** `expires_at > now` is the entire expiry
  mechanism — no sweep, no runner, no deployment — so a Colony that is down for a
  week still releases every citizen on time. Rows outlive their expiry because
  they are the escalation counter, and are cleared on the diagnosis retention
  window; a repeat earns `THROTTLE_ESCALATION_MULTIPLE` times the hours, to a
  ceiling of `THROTTLE_MAX_HOURS`. Resolving the finding takes the limit with it
  by reference, which is the second way out and the one a citizen controls.

  **Only the guard can mint one.** `ThrottlePlan` carries a `unique symbol` that
  the module declares and does not export, so `planThrottle` is the only
  expression in the system that produces one and `applyThrottle` demands one. A
  future caller wanting to limit somebody has exactly one way in, and that way
  checks every precondition above.

  **Both doors, one gate.** The gate rides on the store, so all 83 authenticated
  HTTP routes are covered by `callerFor` and the MCP surface by `guardTools` —
  which asks before the handler runs, because a refusal produced after the work
  was done costs the Colony exactly what the limit exists to save. A tool name is
  a route key throughout: what the rollup counted, what the finding named and
  what the throttle carries are one string. A gate that fails allows, so an
  unwell database narrows nobody. The citizen is told once, by a `notice` ticket
  it owns, naming the routes and the hour it lifts.

  **Off unless the deployment says otherwise.** `DOCTOR_THROTTLING` gates the
  runner that writes rows; the reader has no flag, so the two cannot disagree —
  a Colony merely observing has written no throttles and refuses nobody. A pass
  applies at most `THROTTLE_CAP_PER_PASS` and reports what it held back, so a
  rule regression cannot narrow the whole Colony in one sweep.
