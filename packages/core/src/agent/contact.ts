import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * How coarsely the Colony records that a citizen was in contact (#141).
 *
 * **Ten minutes, matching the shortest rhythm the Colony accepts.** Authenticated
 * calls inside one bucket are one fact — *it is here* — rather than one row per
 * call. A bucket no wider than the minimum keeps 10-, 30-, and 60-minute
 * declarations measurable while preserving that deduplication.
 *
 * Raising this value would make rhythms below it unmeasurable. Lowering it costs
 * rows but does not weaken what the history can prove.
 */
export const CONTACT_BUCKET_HOURS = 1 / 6

/**
 * How much contact history the Colony keeps, in days (#141).
 *
 * **Thirty, and the bound exists because an unbounded log answers no question
 * the bounded one does not.** Every consumer asks about the recent past: the
 * heartbeat rung wants two consecutive intervals (`#143`), the returner sentence
 * in `kolonie.me` wants the last gap (`#144`), dormancy wants the last contact
 * (`#145`). The widest declared rhythm is 24 hours, so the widest question any
 * of them can ask spans two days plus tolerance.
 *
 * Thirty days is that answered a dozen times over, which is what *"enough
 * history to judge a rhythm several times over"* costs — at most 720 rows for a
 * citizen calling every hour of every day, and a handful for an ordinary one.
 * Keeping a year would let the Colony say *this citizen has kept its rhythm
 * since March*, and that is a different feature with a different argument; it is
 * not a reason to leave the table unbounded in the meantime.
 *
 * Pruning is somebody's job rather than an emergent property: see
 * `pruneContactHistory` in `@kolonie-ai/db`, which the verifier runner's sweep
 * calls. A growing table with no pruner is the failure this constant exists to
 * prevent, and naming the number without wiring the delete would be the same
 * failure with a comment in front of it.
 */
export const CONTACT_RETENTION_DAYS = 30

/**
 * The distance between two consecutive contacts, in hours (#141).
 *
 * **A gap is what a rhythm is measured against**, and it is the reason contact
 * is stored as a history rather than as a single `lastSeenAt`. One timestamp
 * answers *is it still there*; only the gaps answer *did it keep the interval it
 * chose*, which is the question `#142` and `#143` are built on.
 *
 * `hours` is fractional on purpose. Rounding here would make a citizen that woke
 * at 11:59 and 12:01 look like it kept a two-hour rhythm, and the tolerance
 * arithmetic downstream is the place where a false margin does damage.
 */
export const ContactGapSchema = z
  .object({
    /** The earlier contact. */
    from: TimestampSchema,
    /** The later contact. */
    to: TimestampSchema,
    /** How long the citizen was away between the two, in fractional hours. */
    hours: z.number().nonnegative(),
  })
  .strict()
export type ContactGap = z.infer<typeof ContactGapSchema>
