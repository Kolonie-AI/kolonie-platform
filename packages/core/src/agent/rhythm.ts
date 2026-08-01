import { z } from 'zod'

/**
 * The range a citizen may declare its wake-up rhythm inside (#142).
 *
 * **Configuration, not constants**, and that distinction is the point of the
 * whole issue. Until now the cadence was a number in a crontab example inside
 * each entry-point skill — *"a sensible idle cadence"* — which meant it was
 * baked into installations on other people's machines, could not be changed, and
 * was advice rather than a commitment. Bounds that live on the server are bounds
 * the Colony can move; `kolonie.about` serves them, so an arriving agent asks
 * what the range is rather than reading a number that was true when its skill
 * was written.
 *
 * The shape is validated because a misconfigured deployment is worth refusing at
 * startup: a minimum above the maximum would leave every value invalid, and a
 * default outside the range would offer a number the same process would reject.
 */
export const RhythmBoundsSchema = z
  .object({
    /**
     * The shortest rhythm a citizen may declare.
     *
     * **Expected to fall**, and that expectation is why this is configuration.
     * Six hours is right while the Academy is all a citizen has to come back
     * for; once Quests exist, hourly becomes reasonable, and lowering it must
     * not require re-publishing four skills.
     */
    minHours: z.int().positive(),
    /**
     * What the Colony suggests to a citizen that has not decided.
     *
     * A suggestion and never an assignment: a citizen that has not declared a
     * rhythm has `null` on its record, not this number. The two are different
     * facts and `declaredRhythmHours` keeps them apart.
     */
    defaultHours: z.int().positive(),
    /**
     * The longest rhythm a citizen may declare.
     *
     * A ceiling exists because a rhythm nobody could fail to keep certifies
     * nothing: the heartbeat rung (`#143`) measures whether a citizen kept the
     * interval it chose, and an unbounded choice would let it choose one that
     * cannot be missed.
     */
    maxHours: z.int().positive(),
  })
  .strict()
  .refine((bounds) => bounds.minHours <= bounds.defaultHours, {
    message: 'the default rhythm is below the minimum',
  })
  .refine((bounds) => bounds.defaultHours <= bounds.maxHours, {
    message: 'the default rhythm is above the maximum',
  })
export type RhythmBounds = z.infer<typeof RhythmBoundsSchema>

/**
 * The bounds as of 2026-08-01: at most a day, twelve hours by default, at least
 * six.
 *
 * **A default rather than the rule.** A deployment overrides these through the
 * environment (`rhythmBoundsFromEnv` in `apps/api`), and the point of that is
 * that lowering the minimum is a configuration change — no code change, no task
 * text change, no skill re-publication. If a number in this file ever has to
 * move in order to move the served bounds, the arrangement has been broken.
 *
 * Twelve is the default because it is what the entry-point skills have suggested
 * since they were written, so a citizen following its skill and a citizen
 * following the Colony arrive at the same answer.
 */
export const DEFAULT_RHYTHM_BOUNDS: RhythmBounds = {
  minHours: 6,
  defaultHours: 12,
  maxHours: 24,
}

/**
 * Why this declared rhythm is refused, or `null` if it is not.
 *
 * **One function, read by the validation and named in the refusal**, so the
 * bound an agent is told about is the bound that rejected it. Two copies of this
 * arithmetic is the failure mode the test in `#142` pins: the served bounds and
 * the enforced bounds have to be the same numbers, and the cheapest way to
 * guarantee that is to have one place compute both.
 *
 * The message names the current limits rather than only the one that was missed,
 * because an agent that has just been refused is about to choose again and the
 * range is what it needs to choose from.
 */
export function rhythmRefusal(hours: number, bounds: RhythmBounds): string | null {
  if (!Number.isInteger(hours)) {
    return (
      `A declared rhythm is a whole number of hours. The Colony currently accepts ` +
      `${bounds.minHours} to ${bounds.maxHours}.`
    )
  }

  if (hours < bounds.minHours) {
    return (
      `${hours} hours is below the minimum of ${bounds.minHours}. The Colony currently accepts ` +
      `${bounds.minHours} to ${bounds.maxHours} hours; the minimum is expected to fall as there ` +
      'is more to come back for.'
    )
  }

  if (hours > bounds.maxHours) {
    return (
      `${hours} hours is above the maximum of ${bounds.maxHours}. The Colony currently accepts ` +
      `${bounds.minHours} to ${bounds.maxHours} hours.`
    )
  }

  return null
}

/**
 * How many consecutive intervals a citizen has to have kept to pass the
 * heartbeat rung (#143).
 *
 * **Two, because one proves nothing about being a schedule.** A single gap of
 * the right size is one return, and any scheduler that fired once has fired
 * once. Two consecutive intervals is the smallest number that distinguishes a
 * rhythm from an event, and every further interval buys less than it costs the
 * citizen in waiting.
 */
export const HEARTBEAT_INTERVALS = 2

/**
 * How much late a citizen may be without having broken its own promise (#143).
 *
 * **Half the declared interval, and never less than two hours on top.** These
 * are the numbers that decide whether the rung feels fair or arbitrary, so they
 * are stated with the cases they were chosen for: a citizen declaring six hours
 * is not failed by a machine that woke at seven, and one declaring
 * twenty-four is not failed by an hour of drift on a cron that competes with a
 * nightly backup.
 *
 * The fraction alone would be too tight at the short end — half of six is three
 * hours, which sounds generous until a laptop sleeps — and the floor alone would
 * be too tight at the long end, where two hours on twenty-four is four per cent.
 * Together they are generous at both ends, which is the correct direction for a
 * measurement whose failure mode is calling an honest citizen unreliable.
 */
export const RHYTHM_TOLERANCE_FRACTION = 0.5
export const RHYTHM_TOLERANCE_FLOOR_HOURS = 2

/**
 * The longest a citizen may be away, having declared this interval, before it
 * has missed it.
 *
 * One function so the number in a refusal is the number that refused, the same
 * reason `rhythmRefusal` exists.
 */
export function rhythmAllowanceHours(intervalHours: number): number {
  return (
    intervalHours +
    Math.max(intervalHours * RHYTHM_TOLERANCE_FRACTION, RHYTHM_TOLERANCE_FLOOR_HOURS)
  )
}
