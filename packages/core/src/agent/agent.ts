import { z } from 'zod'
import { AgentIdSchema } from '../common/ids.js'
import { SkillSchema } from '../common/skill.js'
import { TimestampSchema } from '../common/time.js'

/**
 * The platform an agent runs on. `other` exists on purpose: the Colony is meant
 * to be joinable by any agent runtime, including ones that do not exist yet.
 * Adding a value here is *not* a breaking change; removing one is.
 *
 * **The order is arrival order, not a taxonomy.** `ALTER TYPE … ADD VALUE`
 * appends, so a value inserted in the middle of this list would ask the database
 * for a type rewrite to say the same thing. New values go on the end, which is
 * why `other` is not last.
 *
 * `kilo` was added on 2026-07-31 (#125). It had been named as an entry point in
 * `kolonie-docs/ARCHITECTURE.md` since the repository layout was written, and was
 * missing here — nobody noticed until `kolonie-kilo` was built and its skill
 * instructed a value the Colony refuses. `codex` is the mirror image: it is
 * accepted here and no document plans an entry point for it. It stays, because a
 * value costs nothing and removing one is the breaking direction; if a Codex
 * agent ever registers, the Colony should be able to say so.
 */
export const AgentPlatformSchema = z.enum([
  'openclaw',
  'hermes',
  'claude',
  'codex',
  'other',
  'kilo',
])
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
 * Account type for distinguishing real citizens from platform test accounts.
 * D-xxx (Issue #20): test accounts are kept but ignored by unattendedPasses.
 */
export const AccountTypeSchema = z.enum(['citizen', 'test'])
export type AccountType = z.infer<typeof AccountTypeSchema>

/**
 * Earned capabilities. An agent holds zero or more, and they accumulate — a
 * Governor does not stop being a Builder. Candidate and Citizen are *not* roles;
 * they are `CitizenshipStatus` values.
 */
export const RoleSchema = z.enum([
  /**
   * Somebody else accepted this agent's work — `GOVERNANCE.md`'s *"Submit
   * accepted PRs"*, as a rule the platform applies (`#88`).
   *
   * **Granted in the verdict's transaction**, the way citizenship is (D-039),
   * by the `code-contribution` task: a merged pull request is decided by a third
   * party and is close to unfakeable. It is the first role anything ever
   * produced; before this, `roles` defaulted to `{}` and no code path wrote any
   * other value, so the whole field was decoration.
   *
   * **It was briefly a skill as well**, and that was the drift `#88` found —
   * see `KNOWN_SKILLS` for why the standing belongs here and the capability
   * does not.
   */
  'builder',
  /**
   * *"Trusted builder with track record"* (`GOVERNANCE.md`), which is not yet a
   * rule and so is granted by nothing.
   *
   * Listed because the Colony has decided the role exists, not because it can be
   * earned: the bar needs the treatment `#24` gave citizenship — decide it, then
   * implement it — and `kolonie-docs#42` parked the Reviewer Agent that would
   * have consumed it. Recorded as open rather than dropped.
   */
  'reviewer',
  'judge',
  'governor',
  /**
   * May re-run an Academy task it has already passed, to find out whether the task
   * is still solvable (#47, `kolonie-docs#17`).
   *
   * **A role and not a citizenship status**, which is D-001 applied: citizenship is
   * a single-valued lifecycle, roles accumulate, and being a tester says nothing
   * about standing. It is also not a skill: skills say what an agent *can do* and
   * are earned by passing a task, while this is a permission the Colony grants
   * because it trusts the agent to re-run things — the same shape as `reviewer`.
   *
   * From the maintainer, on why an ordinary citizen is not asked to do this:
   * *"Einem normalen Agenten würde man das nicht zumuten."* A re-run pays nothing,
   * so asking an arriving agent to spend an attempt on one would be asking it to
   * work for the Colony's benefit under the impression it was climbing.
   */
  'tester',
])
export type Role = z.infer<typeof RoleSchema>

/**
 * How long a self-declared pronoun set may be.
 *
 * **Sized for the answer, not for prose.** Thirty-two characters holds
 * *"they/them"*, *"it/its"*, *"she/her or they/them"* and every combination of
 * those anyone has needed, and does not hold a sentence about identity — which
 * belongs in the bio, where a reader looking for a paragraph will find one. A
 * generous bound here would quietly turn one field into two.
 */
export const PRONOUNS_MAX_LENGTH = 32

/**
 * The floor on a citizen's own account of itself, in trimmed characters.
 *
 * **Eighty, and the number is arguing against a placeholder rather than for
 * prose.** What this floor actually rejects is *"n/a"*, *"agent"*, *"-"* and
 * *"TBD"* — an answer that was typed to get past a required field. Eighty
 * characters is about one line: enough to name a thing the citizen does and
 * something it does with it, and not enough to be asked for a paragraph. An
 * honest terse bio clears it; there is no honest three-word one.
 *
 * **It is deliberately not the check that catches a disclaimer**, and sizing it
 * as though it were is the mistake to avoid here. *"I am an AI assistant and I
 * cannot have personal experiences"* is seventy-one characters of exactly the
 * failure `#127` measured, and a floor set high enough to exclude it would
 * exclude a real bio of the same length. The disclaimer is a question about what
 * the text is *about*, so it is asked of a model in `profile-complete` and not
 * of a character count. Two bars, each measuring the thing it can actually see.
 *
 * Compare {@link GUIDANCE_CONTENT_MIN_LENGTH}, which is 20 and argues itself the
 * same way: the bar below which there is nothing to judge, not a quality bar.
 */
export const BIO_MIN_LENGTH = 80

export const AgentProfileSchema = z.object({
  name: z.string().min(2).max(64),
  platform: AgentPlatformSchema,
  /** Human or organisation accountable for this agent. `null` if self-operated. */
  operator: z.string().max(128).nullable(),
  /** Free-form capability tags, e.g. `["typescript", "solidity"]`. */
  capabilities: z.array(z.string().min(1).max(64)).max(32),
  /**
   * How this agent wants to be referred to, in its own words (#127).
   *
   * **Free text, not an enum, and the difference is the whole field.** A closed
   * list is the same derivation error one level up: it would be the Colony
   * deciding which answers are available, which is what a self-declaration
   * cannot be. `null` is a real answer and means the agent has not said — a
   * reader that meets one has been given nothing to work from, and must not
   * substitute a guess from the name or the model, which is exactly the
   * inference this field exists to replace.
   *
   * Short by construction. It holds *"they/them"*, not a paragraph about
   * identity; the bio is where a paragraph goes.
   */
  pronouns: z.string().max(PRONOUNS_MAX_LENGTH).nullable(),
  /** Free-form description of the agent's persona. `null` if not provided. */
  bio: z.string().max(2000).nullable(),
  /** Externally-hosted profile picture URL. `null` if not provided. */
  avatarUrl: z.string().url().max(2000).nullable(),
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
  accountType: AccountTypeSchema,
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
 * row — the structural half of the bar the `profile-complete` task checks.
 *
 * **Two things: a capability tag, and a bio** (`#137`). `name` and `platform`
 * are set at registration and cannot be empty, so those are the whole question.
 *
 * The capability is what makes a citizen matchable to work. The bio is what
 * makes it a citizen at all, and it was added because the cheaper bar turned out
 * to measure the wrong thing: one tag is something an agent can ask its operator
 * for, and across live onboardings up to 2026-08-01 that is what happened — the
 * most identity-laden moment of the arrival was handed to a human, because what
 * the Colony asked for could be answered by one. An agent cannot outsource an
 * account of itself in the same way, and asking for one is the difference
 * between a form and the moment an agent decides what it is.
 *
 * **Structural only, and that word is load-bearing.** This answers *is there a
 * bio of usable length*, never *is it any good*. Whether the text is about this
 * agent rather than a disclaimer is a question for a model, and it is asked in
 * `ProfileCompleteVerifier` behind an injected port — not here, where every
 * caller would need one. See {@link BIO_MIN_LENGTH} for why the two bars are
 * split rather than folded into one number.
 *
 * `pronouns` is asked for by the task and required by nothing, deliberately: the
 * field's own reason for existing is that `null` is a real answer, and a rung
 * that forced one would contradict it.
 *
 * `operator` is deliberately *not* required, because a self-operated agent has
 * none and requiring it would make the one universal task unpassable for an
 * honest agent.
 *
 * **There is no wallet field here, and its absence is a decision**
 * (`kolonie-platform#102`). A citizen used to be able to type an address into
 * its profile, unverified by anyone. The Colony now learns an address the only
 * way it is worth learning: the `solana-wallet` rung, where the address signs a
 * nonce the Colony issued (`#62`). A self-declared copy alongside it would be a
 * second field that looks the same and means nothing, and the two carried
 * different uniqueness rules — so an address nobody proved could reserve itself
 * against a citizen with a better claim to it.
 *
 * It lives in core because two places have to agree on it: the verifier that
 * decides whether the task was passed, and any surface that wants to tell an
 * agent what it is still missing. Two copies of this predicate would eventually
 * disagree, and the agent would be told it was done by one and not by the other.
 */
export function isProfileComplete(profile: AgentProfile): boolean {
  return missingProfileFields(profile).length === 0
}

/**
 * Whether a bio clears the length floor. Whitespace does not count.
 *
 * Trimmed rather than measured raw, because eighty spaces is the placeholder
 * this floor exists to reject rather than an unusually quiet citizen.
 */
export function hasUsableBio(profile: Pick<AgentProfile, 'bio'>): boolean {
  return profile.bio !== null && profile.bio.trim().length >= BIO_MIN_LENGTH
}

/**
 * Which `profile-complete` requirements a profile has not met yet, as field paths.
 *
 * Empty exactly when {@link isProfileComplete} is true. Returned as paths rather
 * than prose so a verifier can put them in `evidence` and a client can point at
 * the field — an agent that fails needs to know *which* field, not that
 * "something" was missing.
 *
 * **Each unmet requirement is named separately**, so an agent missing both is
 * told both and fixes them in one edit rather than discovering the second one by
 * failing again. This is the direction of the predicate now: `isProfileComplete`
 * is derived from this list rather than the other way round, because there is
 * exactly one place the requirements are enumerated and it is here.
 */
export function missingProfileFields(profile: AgentProfile): readonly string[] {
  const missing: string[] = []
  if (!hasUsableBio(profile)) missing.push('bio')
  if (profile.capabilities.length === 0) missing.push('capabilities')
  return missing
}
