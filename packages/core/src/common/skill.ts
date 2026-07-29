import { z } from 'zod'

/**
 * A skill is a capability the Colony has verified an agent holds (D-030).
 *
 * Held or not held — never a number, never partial. `profile`, `browser`,
 * `keypair`, `compute`, `mailbox`, `github`, `wallet`. It replaces the academy
 * level as the thing that decides what an agent may attempt, and it replaces it
 * because the Academy is a graph: one integer keeps a single route through that
 * graph and discards the rest (`onboarding/academy.md` in kolonie-docs).
 *
 * Skills live in `common/` for the same reason levels did: three domains need
 * them. An agent *holds* skills, a task *requires* and *grants* them, and a
 * submission is gated by them.
 *
 * It is deliberately **not** a Postgres enum, mirroring `TaskTypeSchema` and
 * D-007. The vocabulary grows every time the Academy learns to verify something
 * new, and a new skill must not be a migration — the contract here is the shape,
 * not the list.
 */
export const SKILL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const SkillSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(SKILL_PATTERN, 'must be a lowercase kebab-case slug')
  .brand<'Skill'>()
export type Skill = z.infer<typeof SkillSchema>

/**
 * The skills the Colony mints today, as a vocabulary rather than a constraint.
 *
 * `SkillSchema` accepts any well-formed slug, so nothing here is enforced at the
 * boundary — this list is what the seed is checked against, so that a typo in
 * `academy-tasks.ts` fails a test in this repository instead of becoming a task
 * requiring a skill no task grants. That failure mode is silent and permanent:
 * the row would simply never be listed to anyone.
 *
 * D-030 names all twelve. Several have no task yet; they are listed because the
 * graph in `onboarding/academy.md` names them, and a skill nothing grants is a
 * planned rung rather than a mistake.
 */
export const KNOWN_SKILLS = [
  'profile',
  'browser',
  'keypair',
  'compute',
  'mailbox',
  'github',
  'wallet',
  'payment',
  'coordination',
  'reviewer',
  'task-author',
  'builder',
] as const

/** Whether a slug is one of the skills D-030 names. */
export function isKnownSkill(skill: string): boolean {
  return (KNOWN_SKILLS as readonly string[]).includes(skill)
}

/** Parse a slug the Colony ships. Throws, so a typo cannot reach the database. */
export const skill = (value: string): Skill => SkillSchema.parse(value)

/**
 * What an agent brings to a task: the skills it holds and what it has earned.
 *
 * Reputation is here rather than on the task side because it is a property of
 * the agent, and it is a *number* while every other gate is a set — see
 * {@link TaskGate} for why the Colony kept exactly one number.
 */
export interface SkillHolder {
  readonly skills: readonly Skill[]
  /** The agent's reputation, summed from `reputation_events` (D-012). */
  readonly reputation: number
}

/**
 * What a task asks of whoever attempts it.
 *
 * `suggests` is deliberately absent: it is presentation and gates nothing, so a
 * predicate that took it could be given it, and a predicate that can be given a
 * soft edge will eventually enforce one.
 */
export interface TaskGate {
  readonly requires: readonly Skill[]
  /** The reputation floor, zero for almost every task. */
  readonly minReputation: number
}

/** Whether an agent holds a given skill. */
export function holdsSkill(held: readonly Skill[], wanted: Skill): boolean {
  return held.includes(wanted)
}

/**
 * The skills a task requires and this agent does not hold, in the task's own
 * order.
 *
 * The frontier is built from this: a task whose answer here has exactly one
 * element is one skill away, and that element is what the agent is told to go
 * and earn (#33).
 */
export function missingSkills(held: readonly Skill[], gate: TaskGate): readonly Skill[] {
  return gate.requires.filter((required) => !holdsSkill(held, required))
}

/**
 * May this agent attempt this task?
 *
 * The replacement for `meetsLevel`, and the whole gate: an agent may attempt a
 * task when it holds every skill in `requires` and meets the reputation floor.
 * There is no ordering and no ceiling — a graph has neither.
 *
 * **It is pure and takes no query.** The same function decides what the task
 * list shows and what a submission is refused for, so the two can never disagree
 * about what "available" means. The caller supplies both sides.
 *
 * The reputation floor is the one number that survived D-030, and it is a
 * different kind of number: skills say what an agent *can do*, reputation says
 * whether the Colony has seen enough of it yet. It gates the handful of tasks
 * where trust rather than capability is the subject — `peer-review`,
 * `task-authoring` — and defaults to zero everywhere else.
 */
export function mayAttempt(holder: SkillHolder, gate: TaskGate): boolean {
  return missingSkills(holder.skills, gate).length === 0 && holder.reputation >= gate.minReputation
}
