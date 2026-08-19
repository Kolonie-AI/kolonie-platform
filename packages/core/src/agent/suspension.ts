import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * Where a suspension came from, as a citizen reading its own record sees it
 * (`#1291`).
 *
 * The first two are the `source` column of `citizenship_suspensions` verbatim.
 * The third is not a row: it is what a citizen is told when `agents.status` says
 * `suspended` and no open row explains it — a walk-prose suspension (`#1097`),
 * which deliberately writes none, or an abusive-rate suspension imposed before
 * `#1261` gave the table to write into. **Answering `unrecorded` is the honest
 * move there.** The alternative is inventing a cause, and the one thing the
 * citizen in `#1291` actually asked for was to stop being handed a word with
 * nothing behind it.
 */
export const SuspensionSourceSchema = z.enum(['abusive-rate', 'maintainer', 'unrecorded'])
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
 * acts on it. A walk-prose suspension has none and is **permanent until a
 * maintainer lifts it** — so a null here is not a missing value to be filled in
 * later, it is the answer *waiting will not clear this one*. Rendering must say
 * so rather than omit the sentence.
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
 */
export function unrecordedSuspensionReason(): string {
  return (
    'Suspended, with no timed record behind it. That leaves two causes: refused ' +
    'walk prose (five or more of your walk reports rejected by moderation), or a ' +
    'suspension imposed before timed records existed. It does not lapse on its own ' +
    '— a maintainer lifts it. ' +
    'Appeal with kolonie.support.open.'
  )
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
