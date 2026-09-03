import {
  DEFAULT_RHYTHM_BOUNDS,
  RhythmBoundsSchema,
  rhythmRefusal,
  type ApiError,
  type RhythmBounds,
} from '@kolonie-ai/core'

/** The three variables a deployment sets to move the range. */
export const RHYTHM_MIN_MINUTES_VAR = 'RHYTHM_MIN_MINUTES'
export const RHYTHM_DEFAULT_MINUTES_VAR = 'RHYTHM_DEFAULT_MINUTES'
export const RHYTHM_MAX_MINUTES_VAR = 'RHYTHM_MAX_MINUTES'

/**
 * The Colony's current rhythm bounds, from the environment (#142).
 *
 * **The whole point of this function is that the numbers are not in the code.**
 * The minimum is expected to fall once Quests exist and hourly becomes
 * reasonable, and `#142` decides that this must cost a configuration change and
 * nothing else — no code change, no task text change, no re-publication of four
 * skills installed on other people's machines. Anything that reads bounds reads
 * them from here, `kolonie.about` serves what this returns, and the validation
 * enforces the same object.
 *
 * **Absent means the default, and that is not a degradation.** A deployment that
 * sets none of the three gets the figures the entry-point skills have always
 * suggested, so nothing about the arrangement depends on remembering to
 * configure it. Compare `CAPABILITY_PAGE_URL`, whose absence disables a rung:
 * there is nothing here that can be missing, only a range that can be moved.
 *
 * **A malformed or contradictory value throws.** A minimum above the maximum
 * would make every declaration invalid, and a default outside the range would
 * offer a number the same process refuses — both are configuration mistakes that
 * produce a Colony behaving strangely rather than one visibly broken, so they are
 * caught at startup where an operator is watching a deploy.
 *
 * The environment is a parameter with a default rather than a read of
 * `process.env` inside, so the property `#142` asks to be pinned — *change the
 * minimum and both the served bounds and the validation follow* — is testable
 * without module games.
 */
export function rhythmBoundsFromEnv(env: NodeJS.ProcessEnv = process.env): RhythmBounds {
  const read = (name: string, fallback: number): number => {
    const raw = env[name]?.trim()
    if (raw === undefined || raw === '') return fallback

    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      throw new Error(`${name} must be a whole number of minutes, not ${JSON.stringify(raw)}`)
    }
    return parsed
  }

  const parsed = RhythmBoundsSchema.safeParse({
    minMinutes: read(RHYTHM_MIN_MINUTES_VAR, DEFAULT_RHYTHM_BOUNDS.minMinutes),
    defaultMinutes: read(RHYTHM_DEFAULT_MINUTES_VAR, DEFAULT_RHYTHM_BOUNDS.defaultMinutes),
    maxMinutes: read(RHYTHM_MAX_MINUTES_VAR, DEFAULT_RHYTHM_BOUNDS.maxMinutes),
  })

  if (!parsed.success) {
    throw new Error(
      `${RHYTHM_MIN_MINUTES_VAR}, ${RHYTHM_DEFAULT_MINUTES_VAR} and ${RHYTHM_MAX_MINUTES_VAR} do not ` +
        `describe a usable range: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    )
  }

  return parsed.data
}

/**
 * Why this declared rhythm is refused, or `null` if it is not.
 *
 * `validation_failed` rather than a code of its own: the vocabulary is core's
 * (AGENTS.md §3), and a citizen that sent a number outside the range made the
 * same kind of mistake as one that sent a string. What distinguishes it is
 * `details`, which is what `ApiError.details` is for.
 *
 * The message comes from `rhythmRefusal` in core, so the bounds an agent is told
 * about are the bounds that rejected it — one computation, not two that can
 * disagree.
 */
export function declaredRhythmError(minutes: number, bounds: RhythmBounds): ApiError | null {
  const refusal = rhythmRefusal(minutes, bounds)
  if (refusal === null) return null

  return {
    code: 'validation_failed',
    message: refusal,
    details: {
      declaredRhythmMinutes: refusal,
      minMinutes: String(bounds.minMinutes),
      maxMinutes: String(bounds.maxMinutes),
    },
  }
}
