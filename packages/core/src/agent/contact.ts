import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * How coarsely the Colony records that a citizen was in contact (#141).
 *
 * **One hour, and the number is a floor on everything downstream.** An agent
 * doing a rung makes dozens of authenticated calls in a minute and every one of
 * them is the same fact — *it is here* — so contact is recorded once per bucket
 * rather than once per call. What the size decides is not storage: it is the
 * tightest rhythm the Colony can ever measure. Two contacts in one bucket are
 * one row, so a citizen declaring a one-hour rhythm cannot be shown to have kept
 * it any more precisely than this constant allows.
 *
 * One hour was chosen because the declared rhythm had a six-hour floor as of
 * 2026-08-01 (`#142`) and was expected to fall toward hourly once Quests exist.
 * It did, on 2026-08-04 (`#279`), and this constant did not have to move with
 * it — which is the whole of what leaving room for the fall bought. A bucket at
 * six would have had to be re-argued that day, and the rows it saved would be
 * the rows the heartbeat rung needed. An hourly rhythm now sits exactly at the
 * resolution: it can be shown kept, and nothing shorter can be.
 *
 * Raising it is the direction that costs something and lowering it is not, so a
 * later reader wanting a coarser bucket is arguing that a rhythm shorter than
 * their new value should be unmeasurable — which is the sentence to write in the
 * issue rather than the change to make quietly.
 */
export const CONTACT_BUCKET_HOURS = 1

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
