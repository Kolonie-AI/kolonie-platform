<!-- section: Added -->

- **A doctor runner, and it holds no GitHub credential** (`kolonie-platform#839`).
  `apps/doctor-runner` runs the six rules across every citizen that called
  anything in the window, records what it finds, re-evaluates every open
  diagnosis, and sweeps both retention windows. Hourly, because the rollup's
  buckets are hourly and a faster pass sees the same numbers.
- **The absence of a credential is asserted, not promised.** `#407` decided once
  that two processes each holding a write credential is the outcome to avoid, and
  the whole argument for a fourth runner rests on that still being true — so a
  test scans this runner's source for the App variables, the token shapes, the API
  hostname and an octokit import, and its manifest for anything beyond core and
  db. A reviewer cannot be the check for something that would arrive as one
  convenient line two years from now.
- **A pass that throws on one citizen completes for the rest**, names the citizen
  it failed on, and counts it. A pass that stopped at the first exception would
  fail most often on the citizen whose behaviour is unusual — which is the one it
  exists to look at.
- **It is idempotent over the same window** because nothing is held across ticks:
  the dedupe is on the diagnosis row inside Postgres and the re-evaluation closes
  by comparison with what this pass found. A runner whose dedupe a restart could
  defeat is one whose dedupe does not exist.
- It excludes `kolonie.doctor` and `kolonie.wakeup` from what it diagnoses, using
  the same list the live surface does — a citizen told by one that nothing is
  wrong and by the other that it is looping would have been told two things by one
  Colony.
- The two retention sweeps run from this pass rather than from a scheduler of
  their own: a second process for two deletes would be a container, a health
  endpoint and a deployment for one statement each.
