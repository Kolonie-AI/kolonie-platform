import { createLog } from '@kolonie-ai/core'
import {
  attributionCandidates,
  createDatabase,
  databaseUrlFromEnv,
  recordAttributionReading,
  sweepBadges,
} from '@kolonie-ai/db'
import { fetchPage } from '@kolonie-ai/verifiers'
import { startRunner, type Log, type RunnerHealth } from './loop.js'
import { attributionSweep, sweepAttribution } from './attribution.js'
import { badgeSweep } from './sweeps.js'
import { createHealthServer, STALE_POLLS } from './health.js'

/**
 * Entry point of the sweep runner (`#241`, `#315`).
 *
 * Wiring only, like the other three runners: the loops are in `loop.ts`, what a
 * pass is worth saying is in `sweeps.ts`, the criteria and the bookings are in
 * `packages/db`. Nothing here decides anything, which is why nothing here is
 * tested — everything with behaviour is reachable without starting a process.
 *
 * **It is still called `badge-runner`** — in this package, in its image and in
 * its compose service. Renaming it would mean a new image name, a new build job
 * and a deploy in which the old container is not the new one: churn across two
 * repositories to make a directory name match its second occupant. The name is
 * where it entered the world; this comment is where it says what it does.
 */

/**
 * Six hours for badges, which is deliberately slow.
 *
 * Nothing waits on a badge. A citizen that qualified an hour ago and hears about
 * it this evening has lost nothing, and the *"that was nice"* this exists for
 * works exactly as well late. Sweeping every minute would put a full pass over
 * the criteria on the database for a feature that counts for nothing — which is
 * the wrong trade in the one direction that is easy to get wrong.
 */
const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 21_600_000)

/**
 * Six hours for the attribution reading, matching the badge sweep it feeds.
 *
 * **The pass is bounded rather than the interval** — twenty-five pages at a time,
 * and a site that was confirmed is never read again — so the interval decides
 * how long a citizen waits to be seen, not how much of the open web this
 * process touches. A citizen that put the badge up this morning has it by
 * tonight, and nothing in the Colony was waiting for it.
 */
const ATTRIBUTION_INTERVAL_MS = Number(process.env['ATTRIBUTION_INTERVAL_MS'] ?? 21_600_000)
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3004)

const log: Log = createLog({ service: 'badge-runner' })

// Throws with an explanation if DATABASE_URL is missing (D-009), like every
// other process here.
const db = createDatabase(databaseUrlFromEnv())

const badges: RunnerHealth = { running: false, lastPollAt: null, consecutiveFailures: 0 }
const attribution: RunnerHealth = { running: false, lastPollAt: null, consecutiveFailures: 0 }

startRunner(
  badgeSweep(() => sweepBadges(db)),
  log,
  badges,
  POLL_INTERVAL_MS,
)
startRunner(
  attributionSweep(() =>
    sweepAttribution(
      {
        candidates: () => attributionCandidates(db),
        record: (reading) => recordAttributionReading(db, reading),
      },
      {
        // The same SSRF-refusing reader the `website` rung uses. `missing` and
        // `unavailable` are one answer here: neither is a page that failed to
        // carry the link, so neither may be written down as a look.
        read: async (url) => {
          const page = await fetchPage(url)
          return page.outcome === 'read'
            ? { outcome: 'read' as const, html: page.html }
            : { outcome: 'unreadable' as const }
        },
      },
    ),
  ),
  log,
  attribution,
  ATTRIBUTION_INTERVAL_MS,
)

// No queue report: neither loop has a backlog to be behind on. Each sweeps
// everything every time, so *how far behind* is not a question either can be
// asked.
//
// **Every loop named here is started above, and that is a rule rather than an
// observation.** `healthOf` reports a `RunnerHealth` whose `running` is still
// false as `stalled`, and one stalled loop makes the whole report non-ok — so a
// loop listed here and never started reports this process permanently unhealthy,
// for as long as it runs and with nothing in the log to say why. That is what
// `quest-refunds` did between `#553` phase C, which deleted the refund sweep
// with `storage/escrow.ts`, and `kolonie-platform#641`: thirteen consecutive
// deploys rolled back on a container whose only output was `runner.started`.
createHealthServer({
  port: HEALTH_PORT,
  loops: [
    { name: 'badges', health: () => badges, staleAfterMs: POLL_INTERVAL_MS * STALE_POLLS },
    {
      name: 'attribution',
      health: () => attribution,
      staleAfterMs: ATTRIBUTION_INTERVAL_MS * STALE_POLLS,
    },
  ],
}).listen(HEALTH_PORT, () => {
  log.info(`badge-runner health on :${HEALTH_PORT}`, { event: 'runner.started' })
})
