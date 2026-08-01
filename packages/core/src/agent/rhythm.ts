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
