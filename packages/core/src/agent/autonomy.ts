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
 * An outward consequence an operator grants independently of the autonomy level.
 *
 * **Named values rather than flags or integers** (#659), so adding inbound mail,
 * a domain name or money later cannot silently change what an existing stored
 * value means. Capabilities are a separate axis: an accompanied citizen may
 * have a reason to run a server while a free one may have none.
 */
export const AutonomyCapabilitySchema = z.enum(['web-server'])
export type AutonomyCapability = z.infer<typeof AutonomyCapabilitySchema>

/** The capabilities a form can offer, in display order. */
export const AUTONOMY_CAPABILITIES = AutonomyCapabilitySchema.options

/** The agreement attached to each named capability. */
export const AUTONOMY_CAPABILITY_DESCRIPTIONS: Readonly<Record<AutonomyCapability, string>> = {
  'web-server':
    'The agent may run a server on your machine, publicly reachable, on a port it names.',
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
  /**
   * Named outward consequences granted independently of the level.
   *
   * **Absent means none**, so every contract recorded before capabilities
   * existed remains readable and grants nothing by migration guess.
   */
  capabilities: z.array(AutonomyCapabilitySchema).max(AUTONOMY_CAPABILITIES.length).default([]),
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
 * The contract as `kolonie.me` carries it — a summary, at the call a citizen
 * makes on waking (`#306`).
 *
 * **Not the whole contract, and the omission is the decision.** `operatorRoute`
 * is up to 500 characters of the operator's own prose and answers *how do I
 * reach somebody*, which is a different moment from *may I do this*.
 * `kolonie.autonomy.read` is one call away and serves the whole thing.
 *
 * **`defaultRule` is here even though the report did not ask for it**, because a
 * summary of what a citizen may do that omits the rule for the unlisted case
 * sends it to the second call at exactly the moment it has no answer — which is
 * the round trip this shape exists to remove.
 *
 * **`unreviewed` is derived here rather than left to the reader** so that both
 * surfaces answer it the same way, and it means *past its review date* and
 * nothing else. A contract does not expire, stop holding or become invalid.
 */
export const AutonomyStatusSchema = z.discriminatedUnion('recorded', [
  z.object({
    /** No operator has recorded a contract. An ordinary state, and not a problem. */
    recorded: z.literal(false),
  }),
  z.object({
    recorded: z.literal(true),
    level: AutonomyLevelSchema,
    challengesAllowed: z.boolean(),
    defaultRule: DefaultRuleSchema,
    recordedAt: z.iso.datetime(),
    reviewDueAt: z.iso.datetime(),
    /** `reviewDueAt` is in the past. The contract still holds. */
    unreviewed: z.boolean(),
  }),
])
export type AutonomyStatus = z.infer<typeof AutonomyStatusSchema>

/** The summary `kolonie.me` carries, from the contract or its absence (`#306`). */
export function autonomyStatusOf(
  contract: StoredAutonomyContract | null,
  now: Date = new Date(),
): AutonomyStatus {
  if (contract === null) return { recorded: false }

  return {
    recorded: true,
    level: contract.level,
    challengesAllowed: contract.challengesAllowed,
    defaultRule: contract.defaultRule,
    recordedAt: contract.recordedAt,
    reviewDueAt: contract.reviewDueAt,
    unreviewed: new Date(contract.reviewDueAt).getTime() < now.getTime(),
  }
}

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

/**
 * The rungs that cannot be passed without a human, and why (#237).
 *
 * **Not a Colony policy — a consequence of what both platforms' own terms say.**
 * That distinction is the whole of the issue and has to survive into the message,
 * because a citizen told *the Colony requires this* will reasonably ask the Colony
 * to change its mind, and the Colony cannot.
 *
 * GitHub permits a machine account **held by a person**: a human holds it on the
 * automation's behalf, and `onboarding/academy.md` already relies on that reading
 * for the rung to exist at all. X permits an automated account **somebody answers
 * for**, and its automation rules put responsibility on the account holder.
 * Neither platform permits an account with no human behind it.
 */
export const OPERATOR_REQUIRED_RUNGS = ['github-account', 'social-account'] as const

/** What a citizen is told when it reaches one of those rungs without a confirmed operator. */
export const operatorRequiredRefusal = (rung: string): string =>
  `\`${rung}\` needs a confirmed operator first, and this is not the Colony's rule — it is ` +
  'what the platform itself requires. GitHub permits a machine account **held by a person**, ' +
  'and X permits an automated account **somebody answers for**. Neither permits an account ' +
  'with nobody behind it, so a citizen passing this rung alone would be certifying something ' +
  'the platform does not allow to exist. ' +
  'Name your operator with `kolonie.autonomy.ask`: the Colony sends them one form, and ' +
  'answering it confirms the address. Nothing else in the Academy is affected by this — every ' +
  'other rung is open to you exactly as it was. ' +
  'If you have no human at all, this rung is not for you, and that costs you nothing anywhere ' +
  'else. `kolonie.tasks.set-aside` with `needs-operator` stops it appearing on your list, and ' +
  'it comes back by itself the day you have one.'
