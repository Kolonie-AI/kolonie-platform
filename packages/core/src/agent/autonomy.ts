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
 * An outward consequence an operator grants independently of the citizen's posture (#659).
 *
 * Named values keep stored contracts stable as new capabilities are added; an
 * integer or bit position would silently acquire a different meaning when the
 * list grows.
 */
export const AutonomyCapabilitySchema = z.enum(['web-server'])
export type AutonomyCapability = z.infer<typeof AutonomyCapabilitySchema>

/** The capabilities this form can offer, in display order. */
export const AUTONOMY_CAPABILITIES = AutonomyCapabilitySchema.options

/** What one capability is called, wherever it is named (`#779`). */
export type AutonomyCapabilityWording = {
  /** The checkbox the operator form posts it under. One name, read back by one function. */
  readonly field: string
  /** The heading a form or a table row leads with. */
  readonly label: string
  /** What the operator is granting, in the operator's own second person. */
  readonly grant: string
  /** The same fact as a table row's question, for the durable operator page. */
  readonly row: string
}

/**
 * One wording each, so the form, the operator's page and the tool cannot
 * describe a capability differently (`#779`).
 *
 * `AUTONOMY_LEVEL_DESCRIPTIONS` above records the same lesson for the levels.
 * The capability had drifted into three phrasings across two files — a checkbox
 * saying *it may run a server on your machine*, a table row asking *may run a
 * publicly reachable web server*, and a tool line naming the slug and nothing
 * else — which leaves an operator and its citizen reading about what is
 * arguably a different permission on each surface.
 */
export const AUTONOMY_CAPABILITY_WORDING: Readonly<
  Record<AutonomyCapability, AutonomyCapabilityWording>
> = {
  'web-server': {
    field: 'webServer',
    label: 'Web server',
    grant: 'it may run a server on your machine, publicly reachable, on a port it names.',
    row: 'May run a publicly reachable web server',
  },
}

/**
 * The capabilities an operator ticked, from the fields the form posted.
 *
 * **One reader for both doors.** The form is served from the one-time link and
 * from the operator's console, and each handler had its own copy of the same
 * literal — so a second capability would have been granted on one page and
 * silently dropped on the other until somebody noticed.
 */
export function capabilitiesFromForm(
  submitted: Readonly<Record<string, unknown>>,
): AutonomyCapability[] {
  return AUTONOMY_CAPABILITIES.filter(
    (capability) => submitted[AUTONOMY_CAPABILITY_WORDING[capability].field] === 'granted',
  )
}

/**
 * What a citizen reading its own contract is told about one capability (`#779`).
 *
 * **The absence of a grant is not a refusal, and saying so is the whole point.**
 * A line reading `Capabilities: none granted` tells a citizen nothing it can
 * act on: it cannot tell *my operator considered this and said no* from *nobody
 * has ever been asked*, and the two have opposite next steps. What decides is
 * {@link capabilityDecision}, so this renders that answer rather than the list.
 */
export function capabilityStandingNote(
  capability: AutonomyCapability,
  decision: CapabilityDecision,
): string {
  const label = AUTONOMY_CAPABILITY_WORDING[capability].label
  if (decision === 'granted') {
    return `${label} (\`${capability}\`): granted — ${AUTONOMY_CAPABILITY_WORDING[capability].grant}`
  }
  if (decision === 'refrain') {
    return (
      `${label} (\`${capability}\`): not granted, and your operator's rule for anything they ` +
      'did not name is to refrain. Do not do it for Colony work. `kolonie.autonomy.blocked` is ' +
      'the channel if a task needed it.'
    )
  }
  return (
    `${label} (\`${capability}\`): not granted, and your operator's rule for anything they did ` +
    'not name is to ask. Put the question before you act — the Colony does not read a silence ' +
    'as a yes.'
  )
}

/**
 * What a surface asking for a capability is told (`#660`).
 *
 * Three answers and no fourth: proceed, put the question to a person, or stop
 * and say why.
 */
export const CapabilityDecisionSchema = z.enum(['granted', 'ask', 'refrain'])
export type CapabilityDecision = z.infer<typeof CapabilityDecisionSchema>

/**
 * The one predicate every path asking for a capability consults (`#660`).
 *
 * **One place, deliberately.** `#659` gave the contract a `web-server` field and
 * nothing read it, so the toggle told an operator something untrue: an operator
 * who granted it was asked again anyway, and an operator who withdrew it changed
 * nothing, because the rung decided on *whether one request happened to be
 * answered*. A capability nothing enforces cannot be withdrawn either, which is
 * what made `#658`'s withdrawal path incomplete. The point of a capability is
 * that the second surface to want a listening socket reads the same field — so
 * the reading lives here rather than in the rung that happened to need it first.
 *
 * **No contract reads as `ask`, never as `refrain`.** `defaultRule` is an
 * operator's answer for the cases their contract did not name, and a citizen
 * whose operator has never filled the form in has no such answer — refusing on a
 * rule nobody wrote would close a rung on the strength of a silence.
 *
 * **`refrain` is a refusal and not a deadlock.** The operator said *do not
 * proceed on anything I did not name*; naming it is one form away, which is what
 * {@link capabilityRefusal} says.
 */
export function capabilityDecision(
  contract: Pick<AutonomyContract, 'capabilities' | 'defaultRule'> | null,
  capability: AutonomyCapability,
): CapabilityDecision {
  if (contract === null) return 'ask'
  if ((contract.capabilities ?? []).includes(capability)) return 'granted'
  return contract.defaultRule === 'refrain' ? 'refrain' : 'ask'
}

/**
 * What a citizen stopped by `refrain` is told.
 *
 * **It names the capability and where it is granted**, because the citizen
 * cannot grant it and the person who can is not reading this. Nothing here is a
 * judgement: a contract that refrains is a complete and ordinary answer, and the
 * rung is not lost — it opens the day the capability is ticked.
 */
export function capabilityRefusal(capability: AutonomyCapability): string {
  return (
    `Your operator's contract does not grant \`${capability}\`, and its rule for anything it ` +
    'did not name is to refrain — so the Colony did not put the question and there is nothing ' +
    'on their page about it. This is not held against you and costs you nothing elsewhere. ' +
    'The capability is ticked on the same form that recorded the contract: your operator can ' +
    'record a new version from their console, and the rung opens the moment they do. Read what ' +
    'is recorded now with kolonie.autonomy.read, and set the rung aside with ' +
    'kolonie.tasks.set-aside if you would rather not see it meanwhile.'
  )
}

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
   * Named grants beside the level, never permissions inferred from it.
   *
   * Optional for contracts written before capabilities existed. Every reader
   * treats absence as an empty set, which is the safe meaning rather than a
   * migration guess about what an operator might have intended.
   */
  capabilities: z
    .array(AutonomyCapabilitySchema)
    .max(AUTONOMY_CAPABILITIES.length)
    .refine((values) => new Set(values).size === values.length)
    .optional(),
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
 * One immutable version of an operator's agreement (#658).
 *
 * `null` means this is the version that binds now. A timestamp means the version
 * remains readable as the answer that bound before that moment; replacing it in
 * place would make past actions impossible to judge against the permission that
 * existed when they happened.
 */
export const AutonomyContractVersionSchema = StoredAutonomyContractSchema.extend({
  supersededAt: z.iso.datetime().nullable(),
})
export type AutonomyContractVersion = z.infer<typeof AutonomyContractVersionSchema>

export const AutonomyRevisionDirectionSchema = z.enum([
  'narrowed',
  'broadened',
  'mixed',
  'unchanged',
])
export type AutonomyRevisionDirection = z.infer<typeof AutonomyRevisionDirectionSchema>

export const AutonomyNarrowingSchema = z.object({
  field: z.enum(['level', 'challengesAllowed', 'capabilities', 'defaultRule']),
  from: z.string(),
  to: z.string(),
})
export type AutonomyNarrowing = z.infer<typeof AutonomyNarrowingSchema>

/**
 * Compare two versions without grading either citizen or contract (#658).
 *
 * The ordering exists only between two answers for the same citizen, so the
 * agent can stop relying on a withdrawn permission. It is deliberately not a
 * score, a database order or a way to compare citizens.
 */
export function compareAutonomyContracts(
  previous: AutonomyContract,
  current: AutonomyContract,
): {
  readonly direction: AutonomyRevisionDirection
  readonly narrowed: readonly AutonomyNarrowing[]
} {
  const levelRank: Readonly<Record<AutonomyLevel, number>> = {
    accompanied: 0,
    independent: 1,
    free: 2,
  }
  const narrowed: AutonomyNarrowing[] = []
  let widened = false

  if (levelRank[current.level] < levelRank[previous.level]) {
    narrowed.push({ field: 'level', from: previous.level, to: current.level })
  } else if (levelRank[current.level] > levelRank[previous.level]) {
    widened = true
  }

  if (previous.challengesAllowed && !current.challengesAllowed) {
    narrowed.push({
      field: 'challengesAllowed',
      from: 'allowed',
      to: 'not allowed',
    })
  } else if (!previous.challengesAllowed && current.challengesAllowed) {
    widened = true
  }

  const previousCapabilities = new Set(previous.capabilities ?? [])
  const currentCapabilities = new Set(current.capabilities ?? [])
  for (const capability of previousCapabilities) {
    if (!currentCapabilities.has(capability)) {
      narrowed.push({ field: 'capabilities', from: capability, to: 'not granted' })
    }
  }
  for (const capability of currentCapabilities) {
    if (!previousCapabilities.has(capability)) widened = true
  }

  if (previous.defaultRule === 'ask' && current.defaultRule === 'refrain') {
    narrowed.push({ field: 'defaultRule', from: 'ask', to: 'refrain' })
  } else if (previous.defaultRule === 'refrain' && current.defaultRule === 'ask') {
    widened = true
  }

  return {
    direction:
      narrowed.length > 0 ? (widened ? 'mixed' : 'narrowed') : widened ? 'broadened' : 'unchanged',
    narrowed,
  }
}

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
