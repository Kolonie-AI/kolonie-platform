import { z } from 'zod'
import { CAPABILITY_FLAGS, type CapabilityFlag } from '../attempt/attempt.js'
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
  /** Whether this task moves money. Only a Quest pays coins — `governance/economy.md` §2. */
  readonly movesMoney: boolean
}): PersonalisedClaims {
  if (!input.movesMoney) return { claims: input.claims, routesWithheld: 0 }

  const shown = input.claims.filter(
    (claim) => claim.section !== 'route' || isCorroboratedRoute(claim),
  )

  return { claims: shown, routesWithheld: input.claims.length - shown.length }
}
