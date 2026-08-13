<!-- section: Added -->

- **Six deterministic doctor signatures over the call rollup**
  (`kolonie-platform#836`). `packages/core/src/doctor/` exports `diagnose(input)`
  and the six rules behind it: `polling-loop`, `oversized-reads`, `retry-storm`,
  `no-progress`, `stalled-arrival` and `deprecated-route`. Every one is
  arithmetic over stored integers. No model participates, sees a finding before
  it exists, or can change a field on one — the rule
  `apps/support-triage-runner/src/logs.ts` already states, applied to a layer
  that will one day decide whether to limit somebody: _detection is
  deterministic; the model only writes_.
- A `Finding` carries what was seen, how bad it is, and the numbers that prove
  it — with a `confidence` the rule computes from how far past threshold the
  evidence sits and how many hours agree, a `recommendation` slug a citizen can
  branch on, and a `since`/`until` window so a later re-evaluation knows what it
  is replacing. `evidence` holds numbers and route keys and nothing a person
  wrote, which is asserted rather than intended.
- **The rules report shape and never intent.** Nothing in the vocabulary calls a
  citizen an attacker; `polling-loop` says _high rate, nothing changing_, and the
  condition that makes it just is the second half. A citizen making the same
  volume of calls while its record moves produces no finding at all, and that is
  the rejection case the rule set is measured by — a Doctor that cannot tell hard
  work from a loop is worse than no Doctor.
- **A 5xx is never a finding about a citizen.** `retry-storm` splits by class:
  4xx is the citizen's, 5xx is `scope: 'colony'` with the route as its subject.
  `diagnoseColony` is a separate function for the one finding that needs more
  than one citizen's rows, and it names no citizen in what it returns — so a
  per-citizen diagnosis cannot leak another citizen's behaviour, because the
  function that computes one is only ever handed one.
- `DOCTOR_POLICY_VERSION` identifies the judgement rather than the code, and every
  threshold is a named constant carrying the observation that set it — or saying
  plainly that it was estimated.
