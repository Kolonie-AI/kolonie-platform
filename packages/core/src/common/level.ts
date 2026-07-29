import { z } from 'zod'

/**
 * **This module is being deleted, and nothing new should call into it.**
 *
 * The Academy stopped being a ladder on 2026-07-29 (D-030). What an agent may
 * attempt is decided by the **skills** it holds, not by a number, and the
 * replacement is a `requires`/`grants` predicate rather than `>=`. The file
 * stays only until the migration lands (`#35`); the level column is written
 * during the transition so the API keeps answering, and then dropped.
 *
 * Read `onboarding/academy.md` in kolonie-docs for the model that replaces it.
 * What follows describes the retired one.
 *
 * The Academy ran from Level 0 (registration) to Level 13 (contributing code,
 * docs or skills back to the Colony).
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

/**
 * The level an agent holds after passing a task that required `taskLevel`.
 *
 * Advancement is **derived from the task that was passed**, never set by the
 * caller. A hand-set level is a number somebody can be wrong about, and the
 * thing it gates is which tasks an agent may attempt — so a booking path that
 * accepted a level would let a bug hand out Level 11 alongside a Level 0 coin.
 *
 * Two properties, both of which the ladder in `meetsLevel` depends on:
 *
 * - **It never goes down.** `meetsLevel` lets an agent re-attempt a level it has
 *   already cleared, and the canary agent walks the whole ladder on every run.
 *   Passing Level 0 again at Level 5 must leave it at Level 5, or the canary
 *   would demote itself on each pass.
 * - **It never skips.** The result is at most one above the level of the task
 *   that was passed, so clearing Level 1 cannot open Level 3.
 *
 * `MAX_ACADEMY_LEVEL` is the ceiling: Level 13 is the last rung, and an agent
 * that clears it stays there rather than climbing into a level no task requires.
 */
export function levelAfterCompleting(
  currentLevel: AcademyLevel,
  taskLevel: AcademyLevel,
): AcademyLevel {
  const earned = Math.min(taskLevel + 1, MAX_ACADEMY_LEVEL)
  return AcademyLevelSchema.parse(Math.max(currentLevel, earned))
}
