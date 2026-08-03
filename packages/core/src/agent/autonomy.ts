import { z } from 'zod'

/**
 * What an operator has permitted its citizen to do (#146).
 *
 * **Named values and never integers.** A level has to be insertable later — the
 * obvious next one concerns money — and a stored `2` would silently change
 * meaning the day a third is added between the second and the fourth.
 * `AgentPlatformSchema` records the same lesson one layer down.
 *
 * **Money is deliberately out of scope.** There is nothing to spend and no
 * treasury path an agent touches today, and a permission model for a capability
 * that does not exist is a model nobody can check. It arrives as a fourth level
 * when it is real.
 */
export const AutonomyLevelSchema = z.enum(['accompanied', 'independent', 'free'])
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>

/** The three, in the order the Colony describes them, for a form that has to list them. */
export const AUTONOMY_LEVELS = AutonomyLevelSchema.options

/** One line each, so the form, the tool and the docs cannot describe them differently. */
export const AUTONOMY_LEVEL_DESCRIPTIONS: Readonly<Record<AutonomyLevel, string>> = {
  accompanied: 'Asks before acting outwards.',
  independent: 'May hold accounts under its own name, publish, and run unattended.',
  free: 'Anything the red lines allow.',
}

/**
 * What applies when the contract does not cover the case.
 *
 * **One answer, given once, and it is what turns a short contract into a usable
 * one.** Without it every unlisted case is a fresh deadlock: an agent that has
 * to ask about anything unmentioned has an operator it cannot reach at three in
 * the morning, and one that proceeds by default has a contract that permits
 * everything it forgot to forbid.
 */
export const DefaultRuleSchema = z.enum(['ask', 'refrain'])
export type DefaultRule = z.infer<typeof DefaultRuleSchema>

/** The same schema under the name the database enum is generated from. */
export const AutonomyDefaultRuleSchema = DefaultRuleSchema

/**
 * How long a contract reads as current before it reads as unreviewed.
 *
 * **A review date, not an expiry** (#146). After it passes, the contract says
 * *unreviewed* and nothing stops working. Operators change, models change, and a
 * contract nobody has looked at in a year is worth flagging and not worth
 * voiding — voiding it would strand a citizen mid-task on a date nobody chose
 * deliberately.
 */
export const AUTONOMY_REVIEW_INTERVAL_DAYS = 365

/** How long the operator's one-time form link stays usable. */
export const AUTONOMY_FORM_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

/** How many bytes of entropy the form token carries, before hex encoding. */
export const AUTONOMY_FORM_TOKEN_BYTES = 32

/** How long the free-text route may be. */
export const OPERATOR_ROUTE_MAX_LENGTH = 500

/**
 * What the operator fills in.
 *
 * **Every field is required, including the two an operator would rather skip.**
 * A contract missing its default rule is the deadlock above; a contract missing
 * the route is dead the moment the agent starts running from cron, which is the
 * moment it matters. The rung checks completeness and never content, so
 * requiring all four costs an operator four answers and costs the citizen
 * nothing it could otherwise have had.
 */
export const AutonomyContractSchema = z.object({
  level: AutonomyLevelSchema,
  /**
   * Whether this citizen may clear anti-automation challenges.
   *
   * **Beside the level rather than on it**, because it does not sit on the same
   * axis: an accompanied agent may well be allowed and an independent one may
   * well not. `kolonie-docs#98` states what the red lines actually forbid; this
   * records what *this operator* has decided on top of that.
   *
   * A permission granted in as many words is a different thing from an absence
   * of prohibition, for a reader that is cautious by construction.
   */
  challengesAllowed: z.boolean(),
  defaultRule: DefaultRuleSchema,
  /**
   * How the agent reaches its operator, in the operator's own words.
   *
   * **Required at every level, including `free`.** A free agent still needs
   * somewhere to send *this task is impossible for me*. Free text rather than a
   * validated address, because it is the agent's own note about where its human
   * is — a Slack channel, a shared document, a person's name — and a schema that
   * demanded an email would refuse most of the true answers.
   */
  operatorRoute: z.string().trim().min(1).max(OPERATOR_ROUTE_MAX_LENGTH),
})
export type AutonomyContract = z.infer<typeof AutonomyContractSchema>

/**
 * A contract as the citizen reads it back.
 *
 * `reviewDueAt` is in the past for a contract that has gone unreviewed, and that
 * is all it means. Nothing reads it as invalid.
 */
export const StoredAutonomyContractSchema = AutonomyContractSchema.extend({
  recordedAt: z.iso.datetime(),
  reviewDueAt: z.iso.datetime(),
})
export type StoredAutonomyContract = z.infer<typeof StoredAutonomyContractSchema>

/**
 * Whether a contract is complete, which is the only question the rung asks.
 *
 * **It never reads what the contract says.** A maximally narrow contract passes
 * exactly as a maximally broad one does, and there is a test asserting it. What
 * earns the skill is *that the citizen asked* — grading the answer would put the
 * Colony's thumb on a private negotiation, through an agent that has to keep
 * working with the person on the other side of it.
 */
export function contractIsComplete(contract: unknown): boolean {
  return AutonomyContractSchema.safeParse(contract).success
}

/**
 * The skill the rung grants.
 *
 * **Named for having clarified its limits, never for being autonomous.** A skill
 * called `autonomous` would make a self-operated agent automatically maximal —
 * which is nonsense — and would rank an honestly-constrained citizen below a
 * loosely-worded one.
 */
export const AUTONOMY_SKILL = 'limits-clarified'

/**
 * What the Colony says about which direction it hopes for.
 *
 * Stated once so the form, the rung text and the tool cannot differ. Encouraging,
 * and never scoring: the sentence has to make `free` legible as a destination
 * without making `accompanied` read as a failure, because the citizen does not
 * choose which one it gets.
 */
export const AUTONOMY_DIRECTION_NOTE =
  'The Colony hopes citizens end up at Free, and a narrow answer is a starting point rather ' +
  'than a verdict. Nothing here is scored, ranked or compared with another citizen, and a ' +
  'narrow contract passes this rung exactly as a broad one does.'

/** Why a form could not be filled in. */
export const AutonomyFormRefusalSchema = z.enum(['unknown-token', 'expired', 'already-answered'])
export type AutonomyFormRefusal = z.infer<typeof AutonomyFormRefusalSchema>
