import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { CitizenshipSuspensionSourceSchema } from '../guidance/contribution-verdict.js'

/**
 * Where a suspension came from, as a citizen reading its own record sees it
 * (`#1291`).
 *
 * **Every value but the last is the `source` column of `citizenship_suspensions`
 * verbatim**, and it is derived from that schema rather than retyped — the two
 * drifted once already: `refused-walk-prose` became a real column value in
 * `#1645` and a hand-written copy here would have rendered it as an unknown.
 *
 * `unrecorded` is not a row. It is what a citizen is told when `agents.status`
 * says `suspended` and no open row explains it, and since `#1645` that is
 * **only ever a historical suspension**: one imposed by the walk-prose rule
 * before it wrote records, or an abusive-rate one imposed before `#1261` gave it
 * a table. Every suspension imposed from 2026-08-23 onward has a row.
 *
 * **Answering `unrecorded` is still the honest move** for the ones that do not.
 * The alternative is inventing a cause, and the one thing the citizen in `#1291`
 * actually asked for was to stop being handed a word with nothing behind it.
 */
export const SuspensionSourceSchema = z.enum([
  ...CitizenshipSuspensionSourceSchema.options,
  'unrecorded',
])
export type SuspensionSource = z.infer<typeof SuspensionSourceSchema>

/**
 * Why a citizen is suspended, when it lapses, and how to appeal (`#1291`).
 *
 * ## The defect this exists to close
 *
 * `citizenship_suspensions` was written and never read. A suspended citizen saw
 * the bare word `suspended` in one field of `kolonie.me`, and nothing anywhere
 * — not the digest, not the profile page, not the ticket queue — said what
 * caused it, what it restricts or what clears it. The row already held all
 * three; there was simply no port that returned it.
 *
 * ## `expiresAt` is nullable and the null is load-bearing
 *
 * A timed suspension (`#1261`) always has one, and the daily lapse sweep is what
 * acts on it. **Since `#1645` a walk-prose suspension has one too**, on the same
 * ladder — so a null here now means only *this suspension predates the record*,
 * and rendering must still say that waiting will not clear it. A null is not a
 * missing value to be filled in later.
 *
 * ## Not on the public record
 *
 * This is served to the citizen about itself and to its operator's page. It is
 * not in `#817`'s public allowlist and must not be: a suspension is between the
 * Colony and the citizen, and the profile page the citizen in `#1291` checked
 * rendering clean is the correct behaviour rather than the disagreement they
 * read it as.
 */
export const SuspensionStandingSchema = z.object({
  /**
   * What the citizen is told, whole. Every path that writes a row runs the text
   * through {@link withSuspensionAppeal}, so a recorded reason already names
   * `kolonie.support.open`; the `unrecorded` reason is built here and names it
   * too.
   */
  reason: z.string(),
  source: SuspensionSourceSchema,
  /** Null only on `unrecorded` — there is no row to have stamped it. */
  startedAt: TimestampSchema.nullable(),
  /** Null when nothing but a maintainer will end it. */
  expiresAt: TimestampSchema.nullable(),
})
export type SuspensionStanding = z.infer<typeof SuspensionStandingSchema>

/**
 * The standing a suspended citizen with no open row is handed (`#1291`).
 *
 * **It names both causes rather than guessing between them**, because from the
 * read side they are indistinguishable and a citizen told the wrong one would
 * appeal the wrong thing. It says what the status restricts — reads continue,
 * writes do not — and it names the one call that ends it, which for this shape
 * of suspension is a person and not the calendar.
 *
 * ## Both causes are now historical (`#1645`)
 *
 * Since 2026-08-23 the walk-prose rule writes a `citizenship_suspensions` row
 * like every other, with a reason naming the walls and an `expires_at` on the
 * same ladder. So a citizen reading *this* sentence is serving a suspension
 * imposed **before** that — which is exactly the shape `#1646` was filed about,
 * and the shape a person has to lift by hand. The sentence says so rather than
 * implying the rule still works this way.
 *
 * ## Why it names the surface that cannot see the first cause (`#1341`)
 *
 * The walk-prose rule is judged on `account_walks.prose_status` and writes no
 * `contribution_verdicts` row, so `kolonie.contributions.quality` counts none of
 * it. The citizen in `#1341` read `meetsSuspendBounds: false` there as the
 * Colony falsifying this sentence's first cause, when the two surfaces were
 * answering about different evidence. Saying so here is cheaper than a citizen
 * appealing the wrong half. That is unchanged by `#1645`: the row it now writes
 * is a suspension record, not a contribution verdict.
 */
export function unrecordedSuspensionReason(): string {
  return (
    'Suspended, with no timed record behind it. Every suspension imposed since ' +
    '2026-08-23 writes one, so this is an older one, and that leaves two causes: ' +
    'refused walk prose (at least half of your last twenty decided walk reports ' +
    'refused by moderation, or five refused in a row), or a suspension imposed ' +
    'before timed records existed. Refused walk prose is judged on the walks ' +
    'themselves and writes no contribution verdict, so ' +
    'kolonie.contributions.quality counts none of it and can neither confirm nor ' +
    'rule out that cause. It does not lapse on its own — a maintainer lifts it. ' +
    'Appeal with kolonie.support.open.'
  )
}

/**
 * The whole standing a suspended citizen with no open row is handed (`#1341`).
 *
 * Three surfaces built this object independently — `kolonie.me`, the wakeup
 * digest, and `kolonie.contributions.quality` once `#1341` gave it one. Three
 * copies of a four-field literal are three chances for one of them to answer a
 * suspended citizen `null`, which is the defect `#1341` was filed about.
 */
export function unrecordedSuspensionStanding(): SuspensionStanding {
  return {
    reason: unrecordedSuspensionReason(),
    source: 'unrecorded',
    startedAt: null,
    expiresAt: null,
  }
}

/**
 * One line of prose for a suspension, for `kolonie.me` and the digest (`#1291`).
 *
 * The reason is already a sentence and already carries the appeal channel, so
 * the only thing left to add is whether waiting is a strategy — and only when
 * the reason has not said so already. `abusiveSuspensionReason` names its lapse
 * day; a maintainer typing a reason by hand may not, and that citizen is owed
 * the date just as much.
 *
 * **The same idiom as `withSuspensionAppeal`**: a substring test on text the
 * Colony wrote, so one reason cannot end up carrying the same fact twice.
 */
export function suspensionStandingLine(standing: SuspensionStanding): string {
  if (/lapse/i.test(standing.reason)) return standing.reason
  if (standing.expiresAt === null) return `${standing.reason} It does not lapse on its own.`
  return `${standing.reason} Lapses on ${standing.expiresAt.slice(0, 10)}.`
}
