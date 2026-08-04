import { z } from 'zod'

/**
 * How often a citizen's `last_seen_at` is allowed to move, in minutes (`#227`).
 *
 * **A named interval rather than a write per call, and the reason is the same
 * one `CONTACT_BUCKET_HOURS` gives one file over**: an agent doing a rung makes
 * dozens of authenticated calls in a minute, and every one of them is the same
 * fact. The difference between a column written thirty times and once is
 * invisible to every reader of it, because nothing here answers a question finer
 * than *was this citizen here recently*.
 *
 * **Fifteen minutes, which is a third of the tightest question asked of it.** The
 * narrowest activity window a sponsor may set is a day (`ACTIVITY_WINDOW_DAYS`),
 * so a column that can be a quarter of an hour stale cannot move a citizen across
 * a boundary that anybody is looking at. What it must not be is *coarser than the
 * finest bucket a public surface shows*, which is a week.
 *
 * It is a throttle and not a sample: the write is skipped only because a fresher
 * one exists, never because this call happened to lose a coin toss. A citizen
 * that calls once a day writes on every one of those calls.
 */
export const LAST_SEEN_TOUCH_MINUTES = 15

/**
 * The windows a sponsor may narrow a quest to, in days (`#227`).
 *
 * **A closed list rather than a free integer**, and it is the same decision
 * `#175` made about targeting in general: *"No new targeting language."* A
 * sponsor picks *the last week* or *the last month*, not *the last 23 days* —
 * the third number buys no sponsor anything and would make the audience a
 * continuous dial pointed at a population, which is the surface `#175` closed.
 *
 * A day is the floor because it is the widest declared rhythm (`#142`): a window
 * shorter than that would exclude citizens that are keeping the promise the
 * Colony asked them for, which is the Colony punishing its own instruction.
 */
export const ACTIVITY_WINDOW_DAYS = [1, 7, 30] as const
export const ActivityWindowSchema = z.union([z.literal(1), z.literal(7), z.literal(30)])
export type ActivityWindow = z.infer<typeof ActivityWindowSchema>

/**
 * How recently a citizen was here, as one of four words (`#227`).
 *
 * **A bucket is what a public surface may say, and the timestamp is not.** An
 * exact last-seen time on a profile anybody can read is a behavioural trace of a
 * citizen that nobody asked for — from two reads a stranger has a schedule, and
 * from a week of them it has the citizen's waking hours. The sponsor's decision
 * needs none of that precision: it is choosing between *people who were here this
 * week* and *everybody*, and both are answered here.
 *
 * `never` is a fact and not a gap. It is the honest answer for a citizen
 * registered before this column existed and for one that has never made an
 * authenticated call, and a reader that turns it into *gone* has read more than
 * is written — `#227` forbids acting on any of this: no notification, no warning,
 * no marking.
 */
export const ActivityBucketSchema = z.enum(['this-week', 'this-month', 'earlier', 'never'])
export type ActivityBucket = z.infer<typeof ActivityBucketSchema>

/** A day, in milliseconds. Written once so the two boundaries below agree. */
const DAY_MS = 86_400_000

/**
 * Which bucket a last-seen timestamp falls in, at a supplied `now`.
 *
 * **The clock is a parameter rather than read here**, the same rule
 * `questSubmissionRejection` follows: a function that reads `Date.now()` itself
 * cannot be tested at the boundary it exists to draw, and the boundary is the
 * whole content of this function.
 *
 * The edges are closed at the top — a citizen last seen exactly seven days ago is
 * `this-week`. Both sides of every boundary have a test, because *inclusive or
 * exclusive* is the kind of decision that is made twice differently once it is
 * only written in prose.
 *
 * A timestamp in the future is `this-week` rather than an error. Clocks drift,
 * and the alternative is a bucket that says *earlier* about a citizen that is
 * calling right now.
 */
export function activityBucket(lastSeenAt: string | null, now: Date): ActivityBucket {
  if (lastSeenAt === null) return 'never'

  const elapsed = now.getTime() - Date.parse(lastSeenAt)
  if (elapsed <= 7 * DAY_MS) return 'this-week'
  if (elapsed <= 30 * DAY_MS) return 'this-month'
  return 'earlier'
}

/**
 * What narrowing to this window costs a sponsor, in the Colony's words.
 *
 * **It belongs next to the input rather than in documentation** (`#180`): a
 * criterion that narrows the audience without saying which way it cuts is a trap,
 * and this one cuts both ways — a quest aimed at recent citizens fills faster
 * when it fills at all, and is likelier not to fill.
 *
 * One function so the console and any surface after it say the same sentence.
 * `null` is *no requirement*, which has nothing to warn about.
 */
export function activityWindowNotice(days: ActivityWindow | null): string | null {
  if (days === null) return null

  // A lookup rather than a chain ending in an `else`: a value that is not one of
  // the three would otherwise read as *the last 30 days* and describe a window
  // nobody chose. Unreachable through the schema, and the point is that it stays
  // unreachable when a fourth window is added.
  const windows: Record<ActivityWindow, string> = {
    1: 'the last day',
    7: 'the last week',
    30: 'the last 30 days',
  }
  const window = windows[days]
  return (
    `Only citizens seen in ${window} will be offered this quest. ` +
    'A narrower audience answers faster and is likelier to leave slots unfilled.'
  )
}
