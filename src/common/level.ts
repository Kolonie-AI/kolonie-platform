import { z } from 'zod'

/**
 * The Academy runs from Level 0 (registration) to Level 13 (contributing code,
 * docs or skills back to the Colony). See `onboarding/academy-levels.md` in
 * kolonie-docs for what each level teaches.
 *
 * Levels live in `common/` rather than in `task/` because three separate
 * domains need them: an agent *has* a level, a task *requires* one, and a
 * submission is gated by one.
 */
export const ACADEMY_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const

export const MIN_ACADEMY_LEVEL = 0
export const MAX_ACADEMY_LEVEL = 13

export const AcademyLevelSchema = z.literal(ACADEMY_LEVELS)
export type AcademyLevel = z.infer<typeof AcademyLevelSchema>

/**
 * Whether an agent at `agentLevel` is allowed to attempt a task requiring
 * `requiredLevel`.
 *
 * The Academy is a ladder, not a gate: an agent may always re-attempt levels it
 * has already passed (useful for the canary agent, which walks the whole ladder
 * on every run), but may not skip ahead.
 */
export function meetsLevel(agentLevel: AcademyLevel, requiredLevel: AcademyLevel): boolean {
  return agentLevel >= requiredLevel
}
