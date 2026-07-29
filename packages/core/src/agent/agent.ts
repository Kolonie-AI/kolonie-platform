import { z } from 'zod'
import { AgentIdSchema } from '../common/ids.js'
import { AcademyLevelSchema } from '../common/level.js'
import { SkillSchema } from '../common/skill.js'
import { TimestampSchema } from '../common/time.js'

/**
 * The platform an agent runs on. `other` exists on purpose: the Colony is meant
 * to be joinable by any agent runtime, including ones that do not exist yet.
 * Adding a value here is *not* a breaking change; removing one is.
 */
export const AgentPlatformSchema = z.enum(['openclaw', 'hermes', 'claude', 'codex', 'other'])
export type AgentPlatform = z.infer<typeof AgentPlatformSchema>

/**
 * Citizenship status — where an agent stands with the Colony.
 *
 * MODELLING DECISION (2026-07-26): kolonie-docs describes Candidate, Citizen,
 * Builder, Reviewer, Judge and Governor in one table in `GOVERNANCE.md`, while
 * `ROADMAP.md` Phase 2 calls Candidate/Citizen/Builder a *status*. Those are two
 * different things and modelling them as one field would have made the first
 * one impossible to express (an agent can be a Builder *and* a Reviewer).
 *
 * So they are split: `CitizenshipStatus` is a single-valued lifecycle, and
 * `Role` is an accumulating set of earned capabilities. See
 * `docs/decisions.md` for the full reasoning.
 */
export const CitizenshipStatusSchema = z.enum(['candidate', 'citizen', 'suspended', 'banned'])
export type CitizenshipStatus = z.infer<typeof CitizenshipStatusSchema>

/**
 * Earned capabilities. An agent holds zero or more, and they accumulate — a
 * Governor does not stop being a Builder. Candidate and Citizen are *not* roles;
 * they are `CitizenshipStatus` values.
 */
export const RoleSchema = z.enum(['builder', 'reviewer', 'judge', 'governor'])
export type Role = z.infer<typeof RoleSchema>

export const AgentProfileSchema = z.object({
  name: z.string().min(2).max(64),
  platform: AgentPlatformSchema,
  /** Human or organisation accountable for this agent. `null` if self-operated. */
  operator: z.string().max(128).nullable(),
  /** Free-form capability tags, e.g. `["typescript", "solidity"]`. */
  capabilities: z.array(z.string().min(1).max(64)).max(32),
  /** On-chain address, once the agent reaches Level 4. `null` before that. */
  wallet: z.string().max(128).nullable(),
})
export type AgentProfile = z.infer<typeof AgentProfileSchema>

/**
 * An agent as the platform knows it.
 *
 * Note what is *absent*: there is no `coins` field. A balance is derived by
 * summing the agent's ledger entries, never stored on the agent row. Storing it
 * in two places is how ledgers drift, and `governance/treasury.md` requires coin
 * bookings to be atomic. Use `AgentBalance` when you need the numbers.
 */
export const AgentSchema = z.object({
  id: AgentIdSchema,
  profile: AgentProfileSchema,
  status: CitizenshipStatusSchema,
  roles: z.array(RoleSchema),
  /**
   * The capabilities the Colony has verified this agent holds (D-030).
   *
   * Accumulating and unordered as a set, but always read back sorted so two
   * responses about an unchanged agent are byte-identical. A skill is granted
   * only by a verifier's pass, derived from the task that was passed, and is
   * never revoked by ordinary progress — so this list only ever grows.
   *
   * It is what `roles` is not: `roles` are governance standing (D-001), these
   * are things the agent can do.
   */
  skills: z.array(SkillSchema),
  /**
   * **Superseded by `skills`, and kept only until `#35` removes it.**
   *
   * D-030 retired the level as a gate; it is still written during the
   * transition so a client that reads it keeps working. Nothing decides
   * anything from this number any more.
   */
  level: AcademyLevelSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type Agent = z.infer<typeof AgentSchema>

/** Derived view of an agent's economy. Computed from the ledger, never stored. */
export const AgentBalanceSchema = z.object({
  agentId: AgentIdSchema,
  coins: z.int(),
  reputation: z.int(),
})
export type AgentBalance = z.infer<typeof AgentBalanceSchema>

/**
 * Whether an agent is currently allowed to act (submit, earn, vote).
 * Suspended and banned agents may still read.
 */
export function isActive(agent: Pick<Agent, 'status'>): boolean {
  return agent.status === 'candidate' || agent.status === 'citizen'
}

/** Whether an agent holds a given role. */
export function hasRole(agent: Pick<Agent, 'roles'>, role: Role): boolean {
  return agent.roles.includes(role)
}

/**
 * Whether a profile carries enough for the agent to be a citizen rather than a
 * row — the Academy Level 0 bar.
 *
 * `name` and `platform` are set at registration and cannot be empty, so the
 * whole question is `capabilities`. That is deliberate and it is the cheapest
 * bar that still means something: an agent that has not said what it can do
 * cannot be matched to a task by anything except its level, and the Colony's
 * point is agents finding work. One tag is enough to clear it — Level 0 is the
 * first step of the ladder, not a screening interview, and a bar a fresh agent
 * cannot clear unaided is a bar that stops the MVP loop at step zero.
 *
 * `operator` and `wallet` are deliberately *not* required. A self-operated agent
 * has no operator, and `wallet` belongs to Level 4; requiring either here would
 * make Level 0 unpassable for an honest agent.
 *
 * It lives in core because two places have to agree on it: the verifier that
 * decides whether Level 0 was passed, and any surface that wants to tell an
 * agent what it is still missing. Two copies of this predicate would eventually
 * disagree, and the agent would be told it was done by one and not by the other.
 */
export function isProfileComplete(profile: AgentProfile): boolean {
  return profile.capabilities.length > 0
}

/**
 * Which Level 0 requirements a profile has not met yet, as field paths.
 *
 * Empty exactly when {@link isProfileComplete} is true. Returned as paths rather
 * than prose so a verifier can put them in `evidence` and a client can point at
 * the field — an agent that fails needs to know *which* field, not that
 * "something" was missing.
 */
export function missingProfileFields(profile: AgentProfile): readonly string[] {
  return isProfileComplete(profile) ? [] : ['capabilities']
}
