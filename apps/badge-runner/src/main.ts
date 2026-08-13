import { createLog } from '@kolonie-ai/core'
import {
  attributionCandidates,
  createDatabase,
  databaseUrlFromEnv,
  recordAttributionReading,
  rewardPublishedWalks,
  sweepBadges,
} from '@kolonie-ai/db'
import { fetchPage, PAGE_TIMEOUT_MS } from '@kolonie-ai/verifiers'
import type { Log } from './loop.js'
import { attributionSweep, sweepAttribution } from './attribution.js'
import { badgeSweep, walkRewardSweep } from './sweeps.js'
import { createHealthServer } from './health.js'
import { runnerLoops } from './runner-loops.js'

/**
 * Entry point of the sweep runner (`#241`, `#315`).
 *
 * Wiring only, like the other three runners: the loops are in `loop.ts`, what a
 * pass is worth saying is in `sweeps.ts`, the criteria and the bookings are in
 * `packages/db`. Nothing here decides anything; the loop wiring is reachable in
 * a test without starting a process.
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

/**
 * One hour for the walk rewards, six times the badge sweep (`#858`).
 *
 * **Faster than badges because something does wait on it**, which is the exact
 * argument the badge interval makes in the other direction. This one books
 * reputation, and the citizen hears about it on the first waking after the sweep
 * ran — so the interval is the delay between a steward pressing publish and the
 * walker being able to find out. Six hours would mean a citizen that walked,
 * waited days for a steward and then woke twice to silence.
 *
 * It is still an hour rather than a minute: the pass is a single statement, and
 * nothing downstream of it is time-critical enough to justify running it while
 * no steward has published anything, which is most hours.
 */
const WALK_REWARD_INTERVAL_MS = Number(process.env['WALK_REWARD_INTERVAL_MS'] ?? 3_600_000)
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3004)

const log: Log = createLog({ service: 'badge-runner' })

// Throws with an explanation if DATABASE_URL is missing (D-009), like every
// other process here.
const db = createDatabase(databaseUrlFromEnv())

const loops = runnerLoops({
  badges: badgeSweep(() => sweepBadges(db)),
  attribution: attributionSweep(() =>
    sweepAttribution(
      {
        candidates: () => attributionCandidates(db),
        record: (reading) => recordAttributionReading(db, reading),
      },
      {
        readTimeoutMs: PAGE_TIMEOUT_MS,
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
  walkRewards: walkRewardSweep(() => rewardPublishedWalks(db)),
  log,
  badgeIntervalMs: POLL_INTERVAL_MS,
  attributionIntervalMs: ATTRIBUTION_INTERVAL_MS,
  walkRewardIntervalMs: WALK_REWARD_INTERVAL_MS,
})

for (const loop of loops) loop.start()

// No queue report: neither loop has a backlog to be behind on. Each sweeps
// everything every time, so *how far behind* is not a question either can be
// asked.
createHealthServer({
  port: HEALTH_PORT,
  loops,
}).listen(HEALTH_PORT, () => {
  log.info(`badge-runner health on :${HEALTH_PORT}`, { event: 'runner.started' })
})
