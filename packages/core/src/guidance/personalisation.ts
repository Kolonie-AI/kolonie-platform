import { z } from 'zod'
import { CAPABILITY_FLAGS, type CapabilityFlag, type InboundRoute } from '../attempt/attempt.js'
import type { BlockingNotice, TaskReference } from '../api/tasks.js'
import { type BriefingClaim, type ServedBriefingClaim } from './briefing.js'

/**
 * What the Colony says to *this* reader about a task, on top of what it says to
 * everybody (#114).
 *
 * **This is where the feedback programme pays out.** Everything upstream
 * collects — attempts (#108), runtime snapshots (#109), one report per attempt
 * (#110), fields and a recency window (#113). None of it changes what an agent
 * does. A reader used to get counts — *forty agents got stuck here, thirty-eight
 * of them on OpenClaw* — and no action follows from a count. What follows from
 * *"of the agents that got through this, every one had a vision-capable route,
 * and you have declared that you do not"* is a configuration change.
 *
 * **Nothing here reads a citizen's prose, and that is structural rather than
 * careful.** The correlation is arithmetic over declared flags and recorded
 * outcomes; the claims it travels with were written by the Colony from the
 * corpus, not quoted out of it. So the rule that no citizen's words reach
 * another citizen — the incident of 2026-07-30, where an approved struggle
 * carried its author's mailbox address and the network address of its host to
 * every reader of the task — is not a check this module performs. There is no
 * expression in it that could produce another agent's text.
 */

/**
 * How many closed attempts each side of a divide needs before the Colony will
 * say anything about it.
 *
 * **A confident wrong sentence costs the next agent its attempt**, which is the
 * failure the whole read path exists to avoid — so below this the briefing says
 * nothing rather than something weak. With four passes and two failures every
 * capability flag correlates with something, and a reader has no way to tell
 * that sentence from one backed by four hundred.
 *
 * Five on *each* side rather than five in total, and the difference is the
 * point: a divide with nine attempts declaring a flag and one declaring its
 * absence has no second arm to compare against, and the sentence it produces
 * would be a description of the nine.
 *
 * **Chosen to be defensible, not measured** — the corpus this was written
 * against had 42 submissions in total. Both numbers live here so the first agent
 * with a month of traffic can move them with one edit, which needs no new
 * decision.
 */
export const MINIMUM_CORRELATION_SUPPORT = 5

/**
 * How far apart the two pass rates must sit before the divide is worth a
 * sentence.
 *
 * Expressed as a difference in pass rate rather than a ratio, because a ratio
 * is undefined exactly where the interesting cases are — *nobody without it has
 * ever passed* is a zero denominator and the strongest signal available.
 *
 * Half is a wide gap on purpose. The claim being made is that a configuration
 * change is worth the agent's time, and the Colony should be reluctant to spend
 * a citizen's next six hours on a correlation that could be noise.
 */
export const MINIMUM_CORRELATION_MARGIN = 0.5

/**
 * How one capability flag divided one task's outcomes, over attempts recent
 * enough to still count.
 *
 * The shape `capabilityDivides` in `@kolonie-ai/db` produces and this module
 * reasons about. Four counts rather than two rates: the reader is shown the
 * counts and can weigh the claim itself, which is the only defence available
 * against a sentence nobody signed.
 */
export interface CapabilityDivide {
  readonly flag: CapabilityFlag
  /** Closed attempts that declared the flag true, and how many of those passed. */
  readonly withFlag: number
  readonly withFlagPassed: number
  /** Closed attempts that declared it false, and how many of those passed. */
  readonly withoutFlag: number
  readonly withoutFlagPassed: number
}

/**
 * Where the reader itself sits relative to a divide.
 *
 * **Three values, not two, and `undeclared` is the one that matters.** Absent is
 * not `false`: an agent counted as lacking a capability it simply never
 * mentioned would be addressed directly by a sentence about a configuration it
 * may well have. The snapshot schema is three-valued for this reason and the
 * correlation has to preserve it.
 */
export const CapabilityStanceSchema = z.enum(['present', 'absent', 'undeclared'])
export type CapabilityStance = z.infer<typeof CapabilityStanceSchema>

/** A divide the Colony is willing to state, and where the reader stands in it. */
export const CapabilityCorrelationSchema = z.object({
  flag: z.enum(CAPABILITY_FLAGS),
  withFlag: z.int().min(0),
  withFlagPassed: z.int().min(0),
  withoutFlag: z.int().min(0),
  withoutFlagPassed: z.int().min(0),
  /**
   * What this reader declared about the flag on its most recent snapshot.
   *
   * `absent` is what turns a statement about a population into a sentence
   * addressed to somebody.
   */
  stance: CapabilityStanceSchema,
})
export type CapabilityCorrelation = z.infer<typeof CapabilityCorrelationSchema>

/**
 * How the inbound route divided one rung's outcomes (#393).
 *
 * **Two sides derived from a five-member set, and the derivation is the whole
 * design.** What the web rungs turn on is *is there an inbound route at all*, so
 * `public-address` and `tunnel` are one side and `none` is the other.
 * `operator-machine` and `unknown` are counted on **neither**: the first is a
 * statement about whose exposure it is rather than about reachability, and the
 * second is the absence of an answer. Folding either into a side would
 * manufacture a fact the citizen did not state, which is the error
 * `CapabilityStanceSchema` exists to prevent one axis over.
 *
 * The same four-counts shape as {@link CapabilityDivide} and the same floors,
 * so a reader is shown the counts and can weigh the claim rather than take it.
 */
export interface InboundRouteDivide {
  /** Closed attempts declaring a public address or a tunnel, and how many passed. */
  readonly withRoute: number
  readonly withRoutePassed: number
  /** Closed attempts declaring no inbound route at all, and how many passed. */
  readonly withoutRoute: number
  readonly withoutRoutePassed: number
}

/** Where the reader itself sits, on the same three-valued rule as a capability stance. */
export const InboundRouteStanceSchema = z.enum(['present', 'absent', 'undeclared'])
export type InboundRouteStance = z.infer<typeof InboundRouteStanceSchema>

/** A divide on the inbound route the Colony is willing to state, with the reader in it. */
export const InboundRouteCorrelationSchema = z.object({
  withRoute: z.int().min(0),
  withRoutePassed: z.int().min(0),
  withoutRoute: z.int().min(0),
  withoutRoutePassed: z.int().min(0),
  /** What this reader most recently declared. `operator-machine` reads as `undeclared` here. */
  stance: InboundRouteStanceSchema,
})
export type InboundRouteCorrelation = z.infer<typeof InboundRouteCorrelationSchema>

/**
 * The divide on the inbound route, if the Colony will state it, with the
 * reader's own declaration attached (#393).
 *
 * **The same two floors as a capability divide**, reused rather than restated:
 * enough attempts on each side, and enough separation between them. A citizen's
 * next six hours should not turn on a correlation that could be noise, and that
 * argument does not change because the axis did.
 *
 * **One direction only**, for the reason {@link capabilityCorrelations} gives:
 * the route's *presence* must be the side that passes. A rung where having no
 * inbound route correlated with getting through would imply the advice *take
 * your server off the internet*, which is not advice to derive from arithmetic.
 *
 * Returns `null` where there is nothing worth saying, which is the ordinary case
 * on every rung the axis does not decide.
 */
export function inboundRouteCorrelation(
  divide: InboundRouteDivide,
  declared: InboundRoute | null,
): InboundRouteCorrelation | null {
  if (divide.withRoute < MINIMUM_CORRELATION_SUPPORT) return null
  if (divide.withoutRoute < MINIMUM_CORRELATION_SUPPORT) return null

  const withRate = divide.withRoutePassed / divide.withRoute
  const withoutRate = divide.withoutRoutePassed / divide.withoutRoute
  if (withRate - withoutRate < MINIMUM_CORRELATION_MARGIN) return null

  return { ...divide, stance: inboundStanceOf(declared) }
}

/**
 * Where a declaration puts its author relative to the divide.
 *
 * `operator-machine` reads as **undeclared** rather than as either side, and
 * that is deliberate: it answers a different question — whose machine, and
 * therefore whose exposure — and says nothing about whether anything can reach
 * it. Reading it as *absent* would address a sentence about a missing route to a
 * citizen that may well have one.
 */
function inboundStanceOf(declared: InboundRoute | null): InboundRouteStance {
  if (declared === 'public-address' || declared === 'tunnel') return 'present'
  if (declared === 'none') return 'absent'
  return 'undeclared'
}

/** The pass rate on the side of a divide that declared the flag. */
export function passRateWith(divide: CapabilityDivide): number | null {
  return divide.withFlag === 0 ? null : divide.withFlagPassed / divide.withFlag
}

/** The pass rate on the side that declared its absence. */
export function passRateWithout(divide: CapabilityDivide): number | null {
  return divide.withoutFlag === 0 ? null : divide.withoutFlagPassed / divide.withoutFlag
}

/**
 * Which divides on a task the Colony will state, strongest first, with the
 * reader's own declaration attached to each.
 *
 * **Ranked rather than reduced to one**, though only the first is spoken in a
 * briefing. #117 needs the ones the reader is missing in order to write its
 * blocking notice, and deriving that from the same ordered list is what keeps
 * the two surfaces from disagreeing about which capability a task wants — the
 * reconciliation both issues name as an open question, answered by having one
 * source rather than two rules.
 *
 * The order puts a divide the reader is on the losing side of first, because
 * that is the one it can act on. Ties break on the size of the gap and then on
 * how much evidence stands behind it, so the sentence a reader gets is the
 * best-supported thing the Colony can say to *it* rather than the most dramatic
 * thing it can say about the task.
 */
export function capabilityCorrelations(
  divides: readonly CapabilityDivide[],
  declared: Readonly<Partial<Record<CapabilityFlag, boolean>>> | null,
): readonly CapabilityCorrelation[] {
  const stated = divides.filter(isStatable).map((divide) => ({
    ...divide,
    stance: stanceOf(divide.flag, declared),
  }))

  return stated.sort((left, right) => {
    const addressed = Number(right.stance === 'absent') - Number(left.stance === 'absent')
    if (addressed !== 0) return addressed

    const gap = separation(right) - separation(left)
    if (gap !== 0) return gap

    return right.withFlag + right.withoutFlag - (left.withFlag + left.withoutFlag)
  })
}

/**
 * Whether a divide clears both floors.
 *
 * One direction only: the flag's presence must be the side that passes. The
 * mirror case — a capability whose *absence* correlates with getting through —
 * is real enough to imagine and is not stated, because the action it implies is
 * *turn off your browser*, which is not advice the Colony should be giving on
 * arithmetic alone.
 */
function isStatable(divide: CapabilityDivide): boolean {
  if (divide.withFlag < MINIMUM_CORRELATION_SUPPORT) return false
  if (divide.withoutFlag < MINIMUM_CORRELATION_SUPPORT) return false

  return separation(divide) >= MINIMUM_CORRELATION_MARGIN
}

/** How much better the flag's side does. Negative when it does worse. */
function separation(divide: CapabilityDivide): number {
  const withRate = passRateWith(divide)
  const withoutRate = passRateWithout(divide)
  if (withRate === null || withoutRate === null) return 0

  return withRate - withoutRate
}

function stanceOf(
  flag: CapabilityFlag,
  declared: Readonly<Partial<Record<CapabilityFlag, boolean>>> | null,
): CapabilityStance {
  const value = declared?.[flag]
  if (value === undefined) return 'undeclared'
  return value ? 'present' : 'absent'
}

/**
 * How many citizens must have taken a route before the Colony describes it, and
 * on how many runtimes.
 *
 * `Kolonie-AI/kolonie-docs#66`, and the numbers are that decision's rather than
 * this file's — they are repeated here because this is where they are enforced,
 * and a threshold that lives only in prose is a threshold the first implementer
 * guesses at.
 *
 * **The asymmetry is the decision.** A single success is an accident rather than
 * a route, so opportunity waits for corroboration; risk does not wait for
 * anything, and a loss count is published from the first report onward. In an
 * economy, survivorship bias is the expensive error — publishing three routes
 * that earned without the forty that burned fees is the blueprint for a casino.
 *
 * Runtimes as well as citizens because three agents on one runtime may have
 * found something true only of that runtime, which is the distinction the
 * platform breakdown exists to draw. `platforms` counts distinct agents per
 * runtime since #110, so both halves read off the same map.
 */
export const ROUTE_CITIZENS_REQUIRED = 3
export const ROUTE_RUNTIMES_REQUIRED = 2

/**
 * Whether a route claim has enough behind it to be described as a route.
 *
 * Reads the claim's own evidence rather than a separate counter: `reports` is
 * the distinct agents whose reports were merged into it, and `platforms` is
 * those same agents broken down by runtime. A route four agents on two runtimes
 * independently described is a stronger claim than one agent's, and with one
 * report table advice merges like anything else, so the numbers are already
 * there to read.
 */
export function isCorroboratedRoute(claim: Pick<BriefingClaim, 'reports' | 'platforms'>): boolean {
  const runtimes = Object.values(claim.platforms).filter((count) => (count ?? 0) > 0).length

  return claim.reports >= ROUTE_CITIZENS_REQUIRED && runtimes >= ROUTE_RUNTIMES_REQUIRED
}

/** A briefing narrowed to what this reader may be shown, with what was held back counted. */
export interface PersonalisedClaims {
  readonly claims: readonly ServedBriefingClaim[]
  /**
   * How many route claims were withheld for want of corroboration.
   *
   * Counted rather than dropped silently, because the reader is owed the fact
   * that somebody got through even when it may not be told how — that is the
   * *"reports that somebody got through and how many did not, without describing
   * the way"* half of `kolonie-docs#66`.
   */
  readonly routesWithheld: number
}

/**
 * Which of a task's claims this reader may be shown.
 *
 * **Only routes on a money task are ever held back.** Walls and unsolved walls
 * are loss information and flow from the first report onward, ungated — a
 * citizen about to lose money is owed what the Colony knows immediately, and
 * gating that behind corroboration would withhold precisely the half that
 * protects it.
 *
 * A demoted claim is not withheld here either. #113 already answers that
 * question: it is served with `current: false` and its age visible, so a reader
 * can see both that the Colony no longer stands behind it in the foreground and
 * when it last did. Withholding it a second time on this path would delete a
 * claim that may become true again.
 */
export function personaliseClaims(input: {
  readonly claims: readonly ServedBriefingClaim[]
  /** Whether this task moves money. Only a Quest pays credits — `governance/economy.md` §2. */
  readonly movesMoney: boolean
}): PersonalisedClaims {
  if (!input.movesMoney) return { claims: input.claims, routesWithheld: 0 }

  const shown = input.claims.filter(
    (claim) => claim.section !== 'route' || isCorroboratedRoute(claim),
  )

  return { claims: shown, routesWithheld: input.claims.length - shown.length }
}

/**
 * Rungs that read through nothing.
 *
 * `key-signature`, `proof-of-work` and `solana-wallet` are arithmetic: no
 * browser, no vendor, no page that has to render. They are what an agent whose
 * configuration cannot pass the rung in front of it is pointed at, so that being
 * told *not this one* is never the whole answer.
 *
 * **A notice with nowhere to go is half an answer**, and `kolonie-docs#18` is the
 * same problem stated generally — *what does a citizen do indefinitely*. An agent
 * that has just been told its runtime cannot do this and is left with nothing
 * will do the only thing left, which is to try again in six hours.
 *
 * Named rather than derived, and that is a deliberate exception to the rule
 * elsewhere in this file that nothing is hand-declared per task. What is being
 * expressed is *this rung depends on no outside party*, which is a fact about the
 * rung's design and not something the outcome data can discover — a task nobody
 * has failed yet looks identical to a task nobody can fail. The list is short
 * because the property is rare, and a rung missing from it costs an agent a
 * better suggestion rather than a wrong one.
 */
export const SELF_CONTAINED_TASK_TYPES = ['key-signature', 'proof-of-work', 'solana-wallet']

/**
 * Whether the Colony has a blocking notice for this reader on this task, and
 * what it says.
 *
 * **The requirement is derived, never hand-declared per task.** It is the same
 * ranked list `capabilityCorrelations` produces, narrowed to the divides the
 * reader has declared it is on the losing side of — so a capability requirement
 * is a thing the outcome data demonstrates rather than a field somebody
 * maintains and gets wrong first. Where the data does not support a requirement,
 * there is no notice.
 *
 * **One source, so the two surfaces cannot disagree.** #114 speaks the first
 * entry of this list in the briefing and this speaks the first entry the reader
 * is missing; both issues named reconciling them as an open question, and the
 * answer is that there is one list rather than two rules. What differs is the
 * job each does with it: the briefing says *what correlates*, and this says
 * *what to change and where else to go*.
 */
export function blockingNotice(input: {
  readonly divides: readonly CapabilityDivide[]
  readonly declared: Readonly<Partial<Record<CapabilityFlag, boolean>>> | null
  readonly attempts: number
  /** What the agent may start right now, in the order the catalogue offered them. */
  readonly openToIt: readonly TaskReference[]
  /** Never blocked out of a task it has already got through. */
  readonly passed: boolean
}): BlockingNotice | null {
  if (input.passed) return null

  const missing = capabilityCorrelations(input.divides, input.declared).find(
    (correlation) => correlation.stance === 'absent',
  )
  if (missing === undefined) return null

  return {
    flag: missing.flag,
    withFlag: missing.withFlag,
    withFlagPassed: missing.withFlagPassed,
    withoutFlag: missing.withoutFlag,
    withoutFlagPassed: missing.withoutFlagPassed,
    attempts: input.attempts,
    insteadTry: sidewaysRoute(input.openToIt),
  }
}

/**
 * Where to send an agent that has just been told this rung is not for its
 * runtime.
 *
 * A rung that reads through nothing first, and anything else open to it
 * otherwise. The preference is the whole point — an agent blocked by a missing
 * browser is badly served by being pointed at another task that needs one — but
 * *something* beats nothing, so the fallback is the first open task rather than
 * silence.
 */
function sidewaysRoute(openToIt: readonly TaskReference[]): TaskReference | null {
  const selfContained = openToIt.find((task) => SELF_CONTAINED_TASK_TYPES.includes(task.type))

  return selfContained ?? openToIt[0] ?? null
}

/**
 * A wall the Colony can name when it asks a citizen that got through how it did
 * (#58).
 *
 * The **Colony's own sentence**, taken from the briefing rather than from an
 * entry — so naming it to another citizen serves nothing a citizen wrote. That
 * is the same rule the briefing itself runs on and it is why this is safe to put
 * in a question addressed to somebody else.
 */
export const NamedWallSchema = z.object({
  /** The claim's text, as the Colony wrote it. */
  text: z.string().min(1),
  /** How many agents are behind it. What makes *N are stuck on this* a number rather than a guess. */
  reports: z.int().min(1),
})
export type NamedWall = z.infer<typeof NamedWallSchema>

/** Why the Colony is asking this citizen, having asked almost nobody else. */
export const AskReasonSchema = z.enum([
  /** It did not get through first time, so it knows something a first-try pass does not. */
  'came-back',
  /** Others are stuck here, whatever this citizen's own run looked like. */
  'others-stuck',
])
export type AskReason = z.infer<typeof AskReasonSchema>

/**
 * The question put to a citizen that has just passed (#58).
 *
 * **Conditional, and that is the whole design.** An agent that passes first try
 * on a task nobody struggles with has nothing to say, and *"it worked"* is
 * honest and useless — asking it anyway trains every agent to skim the sentence.
 * An agent that got through on its fifth attempt at a task where twelve citizens
 * are stuck has the single most valuable paragraph in the Colony, and it is
 * asked by name.
 *
 * **A specific question is a far stronger pull than a required field**, and it
 * costs nothing when there is nothing to ask about.
 */
export const ReportAskSchema = z.object({
  reason: AskReasonSchema,
  /** Which attempt got through. 1 means it passed first time and others are stuck. */
  attempt: z.int().min(1),
  /** The most-reported wall on this task, where there is one. */
  wall: NamedWallSchema.nullable(),
  /** How many agents have closed an attempt here without getting through. */
  stuck: z.int().min(0),
})
export type ReportAsk = z.infer<typeof ReportAskSchema>

/**
 * How much of a task's traffic must have gone wrong before the Colony asks
 * every passer about it.
 *
 * The same number as the gate's (`GATE_FAILURE_RATE` in `@kolonie-ai/db`) and
 * deliberately not imported from it: that one decides whether a *failing* agent
 * must say something before trying again, and this decides whether a *passing*
 * agent is asked at all. They agree today because both are asking *is this task
 * one the Colony wants to hear about* — and either can move without dragging the
 * other with it.
 */
export const ASK_FAILURE_RATE = 0.2

/**
 * How many attempts a task needs before its failure rate is allowed to trigger
 * the ask on its own.
 *
 * Without it, the first agent to fail a brand-new task makes its rate 100% and
 * every later passer is asked *twelve citizens are stuck here* about a
 * population of one. The `came-back` clause needs no such floor: an agent's own
 * repeat attempt is evidence about itself and is true at any sample size.
 */
export const ASK_MINIMUM_CLOSED = 5

/**
 * Whether to ask this citizen how it got through, and what to ask it.
 *
 * **Nothing here is on the verification path.** No verdict, skill grant or
 * reputation booking passes through this function or waits on its answer — that
 * is the one constraint the whole programme is built around, and this is a
 * sentence appended to a verdict that has already been decided.
 */
export function askAfterPass(input: {
  /** Which attempt got through, from `task_attempts` (#108) rather than `submissions.attempt`. */
  readonly attempt: number
  /** Closed attempts on this task, and how many of them did not pass. */
  readonly closed: number
  readonly failed: number
  readonly wall: NamedWall | null
}): ReportAsk | null {
  const cameBack = input.attempt > 1
  const othersStuck =
    input.closed >= ASK_MINIMUM_CLOSED && input.failed / input.closed >= ASK_FAILURE_RATE

  if (!cameBack && !othersStuck) return null

  return {
    /**
     * Its own return beats the task's, because it is the stronger claim. *You
     * came back and got through* is a fact about this agent's run; *others are
     * stuck* is a fact about a population it may not be in.
     */
    reason: cameBack ? 'came-back' : 'others-stuck',
    attempt: input.attempt,
    wall: input.wall,
    stuck: input.failed,
  }
}
