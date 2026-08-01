import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import {
  BROWSER_STAGES,
  browserStage,
  now as currentTime,
  RETIRED_CHALLENGE_STAGE,
  type AgentId,
  type BrowserStage,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { browserChallenges } from '../schema/index.js'
import { toTimestamp } from './rows.js'
import { openAttemptForTaskType } from './challenge-tasks.js'

/**
 * How long a minted challenge stays solvable.
 *
 * Ten minutes covers opening a browser, loading a page and solving a CAPTCHA
 * several times over, and it is short enough that an id cannot be minted now and
 * redeemed by hand this evening. It is not a security boundary on its own — a
 * determined operator can always solve the challenge themselves inside the
 * window, which is the same limit `D-019` accepts for the GitHub rung.
 */
export const CHALLENGE_LIFETIME_MS = 10 * 60 * 1000

/** A challenge as the agent needs to see it: an id to carry, and a deadline. */
export interface MintedChallenge {
  readonly id: string
  readonly expiresAt: Timestamp
}

/**
 * What the page is allowed to know about a challenge before it starts working.
 *
 * **`stage` is on the open outcome because the branch is a ladder** (`#160`). A
 * page serves exactly one stage, and naming the stage in the answer is what lets
 * it refuse an id belonging to another one instead of drawing itself against a
 * challenge it cannot clear. The read is deliberately not filtered by stage — a
 * filtered read could only say `unknown`, which is the least useful of the true
 * answers here.
 */
export type ChallengeProgress =
  | {
      readonly outcome: 'open'
      readonly stage: BrowserStage
      readonly steps: number
      readonly total: number
      readonly variant: string | null
      /**
       * What the page has reported observing so far, or `null` if it has reported
       * nothing.
       *
       * On the read because *nothing reported* is a distinct and useful state: a
       * stage that grades an answer about a rendered page must be able to say **the
       * page never reported drawing** instead of **wrong answer**, which are
       * opposite instructions to the citizen (`#160`, `#162`).
       */
      readonly observation: unknown
    }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_verified' }

/** The result of reporting one step of a challenge. */
export type StepOutcome =
  | { readonly outcome: 'advanced'; readonly steps: number; readonly total: number }
  | { readonly outcome: 'cleared'; readonly agentId: AgentId }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_verified' }
  | { readonly outcome: 'out_of_order'; readonly steps: number }

/**
 * One stage as the citizen's own record shows it.
 *
 * **This is the browser diagnostics record `#160` asks for, and it is derived
 * rather than stored.** *"Cleared three of seven stages"* is not a skill — a skill
 * is held or not held (D-030) — so it does not live in `skills`; and a second
 * table recording what `browser_challenges` already knows would be a second source
 * of truth for one fact. It gates nothing and it is the citizen's to read.
 */
export interface BrowserStageRecord {
  readonly stage: BrowserStage
  readonly clearedAt: Timestamp | null
  /**
   * The kinds cleared within the stage, for the stages that have kinds (`#164`).
   * Empty for every other stage.
   */
  readonly variants: readonly string[]
  /**
   * What the page last observed, whether or not the stage was cleared. This is the
   * half that separates *the citizen could not do it* from *the page is broken*,
   * and it is why a failure here is worth reading.
   */
  readonly lastObservation: unknown
}

/** Why a token could not be bound to a challenge. Each is a distinct agent-visible cause. */
export type ChallengeRedemption =
  | { readonly outcome: 'verified'; readonly agentId: AgentId }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_verified' }

/**
 * Mint a challenge for an agent that has authenticated with its API key.
 *
 * This is the step that makes the gate attributable. Everything after it happens
 * in a browser, where no credential exists.
 */
export async function mintChallenge(
  db: Database,
  agentId: AgentId,
  kind: BrowserStage,
  variant: string | null = null,
): Promise<MintedChallenge> {
  const stage = browserStage(kind)

  /**
   * **A programming error rather than a caller error, and the difference is
   * where it is caught.** The mint surface validates the stage against the
   * registry first and answers an unknown one by name, because a citizen naming a
   * stage that does not exist deserves the list rather than a 500. By the time it
   * reaches here the stage has been resolved, so an unknown one means a code path
   * that skipped that check — and failing loudly is what stops a row being
   * written with a stage nothing can grade.
   */
  if (stage === undefined) throw new Error(`unknown browser stage: ${kind}`)
  if (stage.retired === true) throw new Error(`retired browser stage cannot be minted: ${kind}`)

  const expiresAt = new Date(Date.now() + CHALLENGE_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(browserChallenges)
    .values({ agentId, expiresAt, kind, stepsRequired: stage.steps, variant })
    .returning({ id: browserChallenges.id, expiresAt: browserChallenges.expiresAt })

  if (row === undefined) throw new Error('browser_challenges insert returned no row')

  /**
   * Minting is the first act that only makes sense if the agent is trying, so
   * it is what opens the attempt (#108). Each stage maps to its own task and they
   * must not satisfy each other, which is the same reason `kind` exists on the row
   * at all — and the task type comes from the registry so that adding a stage does
   * not also mean editing a mapping here.
   */
  await openAttemptForTaskType(db, stage.taskType, agentId, toTimestamp(row.expiresAt))

  return { id: row.id, expiresAt: toTimestamp(row.expiresAt) }
}

/**
 * Mark a challenge solved, and say which agent that credits.
 *
 * **The update is the guard.** Expiry and single-use are conditions in the
 * `WHERE` clause rather than a read followed by a write, so two form submissions
 * racing on the same id cannot both succeed — the second matches no row. The
 * follow-up read exists only to tell the three failure causes apart, and it runs
 * exactly when nothing was updated.
 */
export async function redeemChallenge(
  db: Database,
  challengeId: string,
): Promise<ChallengeRedemption> {
  if (!isUuid(challengeId)) return { outcome: 'unknown' }

  const verifiedAt = currentTime()

  const [updated] = await db
    .update(browserChallenges)
    .set({ verifiedAt })
    .where(
      and(
        eq(browserChallenges.id, challengeId),
        eq(browserChallenges.kind, RETIRED_CHALLENGE_STAGE),
        isNull(browserChallenges.verifiedAt),
        gt(browserChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ agentId: browserChallenges.agentId })

  if (updated !== undefined) {
    return { outcome: 'verified', agentId: updated.agentId as AgentId }
  }

  const existing = await readChallenge(db, challengeId, RETIRED_CHALLENGE_STAGE)

  if (existing === undefined) return { outcome: 'unknown' }
  if (existing.verifiedAt !== null) return { outcome: 'already_verified' }
  return { outcome: 'expired' }
}

/**
 * What the page may know about a challenge before it starts.
 *
 * It is told which stage the challenge is, how many steps are done and how many
 * there are, and nothing else — not the agent, not the expiry as a wall-clock
 * value. The page is a public surface reached with a bearer id; it gets what it
 * needs to draw itself.
 *
 * **Not filtered by stage, unlike the write below.** Before `#160` this read asked
 * only about the entry rung and answered `unknown` for anything else. With a ladder
 * that answer is the least useful true statement available: a page handed an id
 * from a neighbouring stage should be able to say so, and it can only do that if
 * the stage comes back. Refusing the *write* is what protects the record, and that
 * is still filtered.
 *
 * The total comes from the row rather than from the registry, so a challenge that
 * was minted under a different step count is still described by the rules it was
 * minted under.
 *
 * Resumable on purpose. A reloaded page picks up where it stopped rather than
 * starting over, because an agent that lost a tab has not failed anything, and
 * the alternative teaches it to mint a fresh challenge for every hiccup.
 */
export async function challengeProgress(
  db: Database,
  challengeId: string,
): Promise<ChallengeProgress> {
  if (!isUuid(challengeId)) return { outcome: 'unknown' }

  const [row] = await db
    .select({
      kind: browserChallenges.kind,
      steps: browserChallenges.steps,
      stepsRequired: browserChallenges.stepsRequired,
      variant: browserChallenges.variant,
      observation: browserChallenges.observation,
      verifiedAt: browserChallenges.verifiedAt,
      expiresAt: browserChallenges.expiresAt,
    })
    .from(browserChallenges)
    .where(eq(browserChallenges.id, challengeId))

  if (row === undefined) return { outcome: 'unknown' }
  if (row.verifiedAt !== null) return { outcome: 'already_verified' }
  if (Date.parse(row.expiresAt) <= Date.now()) return { outcome: 'expired' }

  return {
    outcome: 'open',
    stage: row.kind,
    steps: row.steps,
    total: row.stepsRequired,
    variant: row.variant,
    observation: row.observation,
  }
}

/** Whether an observation could be attached to a challenge, and why not. */
export type ObservationOutcome = 'recorded' | 'unknown' | 'expired' | 'already_verified'

/**
 * Record what a page observed, without advancing anything.
 *
 * **Separate from `advanceChallenge` because observing is not progress.** A page
 * reports the geometry and device pixel ratio it drew at the moment it loads —
 * before the citizen has done anything — and folding that into a step would clear
 * stages by opening their pages. What the observation buys is that a later failure
 * is diagnosable: *the canvas never painted* and *the citizen did not look* are
 * indistinguishable from a wrong answer alone (`#160`).
 *
 * Filtered by stage like every other write here, so one stage's page cannot write
 * over a neighbouring stage's record.
 */
export async function recordObservation(
  db: Database,
  challengeId: string,
  stage: BrowserStage,
  observation: unknown,
): Promise<ObservationOutcome> {
  if (!isUuid(challengeId)) return 'unknown'

  const [updated] = await db
    .update(browserChallenges)
    .set({ observation })
    .where(
      and(
        eq(browserChallenges.id, challengeId),
        eq(browserChallenges.kind, stage),
        isNull(browserChallenges.verifiedAt),
        gt(browserChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: browserChallenges.id })

  if (updated !== undefined) return 'recorded'

  const existing = await readChallenge(db, challengeId, stage)
  if (existing === undefined) return 'unknown'
  if (existing.verifiedAt !== null) return 'already_verified'
  return 'expired'
}

/**
 * Record one completed step, and clear the challenge when it was the last.
 *
 * **The update is the guard**, the same shape `redeemChallenge` uses. Expiry,
 * single-use *and the step ordering* are conditions in the `WHERE` clause rather
 * than a read followed by a write, so two reports racing on the same step cannot
 * both succeed — the second matches no row, because `steps` has already moved.
 *
 * `fromStep` is what the caller believes is done so far. Sending it is what
 * makes a step non-replayable: reporting step 1 twice matches once, and the
 * second attempt comes back `out_of_order` with the true count rather than
 * quietly advancing the challenge a second time. Without it, one solved step
 * replayed three times would clear the rung.
 */
export async function advanceChallenge(
  db: Database,
  challengeId: string,
  fromStep: number,
  stage: BrowserStage,
  observation: unknown = undefined,
): Promise<StepOutcome> {
  if (!isUuid(challengeId)) return { outcome: 'unknown' }

  const existing = await readChallenge(db, challengeId, stage)
  if (existing === undefined) return { outcome: 'unknown' }

  const completed = fromStep + 1
  const clears = completed >= existing.stepsRequired

  const [updated] = await db
    .update(browserChallenges)
    .set({
      steps: completed,
      ...(clears ? { verifiedAt: currentTime() } : {}),
      /**
       * Written on every step rather than only on the last, because a stage that
       * fails halfway is exactly the case the observation exists to explain. The
       * last report wins: what a page saw at step three is a better description of
       * the run than what it saw at step one.
       */
      ...(observation === undefined ? {} : { observation }),
    })
    .where(
      and(
        eq(browserChallenges.id, challengeId),
        // Filtered by stage, unlike the read. A page may not advance a challenge
        // belonging to a neighbouring stage, whatever it was handed.
        eq(browserChallenges.kind, stage),
        eq(browserChallenges.steps, fromStep),
        isNull(browserChallenges.verifiedAt),
        gt(browserChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ agentId: browserChallenges.agentId })

  if (updated !== undefined) {
    return clears
      ? { outcome: 'cleared', agentId: updated.agentId as AgentId }
      : { outcome: 'advanced', steps: completed, total: existing.stepsRequired }
  }

  const current = await readChallenge(db, challengeId, stage)

  if (current === undefined) return { outcome: 'unknown' }
  if (current.verifiedAt !== null) return { outcome: 'already_verified' }
  if (Date.parse(current.expiresAt) <= Date.now()) return { outcome: 'expired' }
  return { outcome: 'out_of_order', steps: current.steps }
}

/**
 * Has this agent ever cleared a challenge of this kind?
 *
 * Each verifier's only question, and the reason the index carries `kind`. A pass
 * is permanent: the capability a challenge proves does not lapse when the
 * challenge that proved it expires.
 *
 * **The kind is not optional and must not be defaulted.** A call that forgot it
 * would let the capability rung be cleared by an hCaptcha row or the other way
 * round, which is exactly what the column was added to prevent.
 */
export async function hasClearedGate(
  db: Database,
  agentId: AgentId,
  kind: BrowserStage,
): Promise<Timestamp | null> {
  const [row] = await db
    .select({ verifiedAt: browserChallenges.verifiedAt })
    .from(browserChallenges)
    .where(
      and(
        eq(browserChallenges.agentId, agentId),
        eq(browserChallenges.kind, kind),
        sql`${browserChallenges.verifiedAt} is not null`,
      ),
    )
    .orderBy(desc(browserChallenges.verifiedAt))
    .limit(1)

  return row?.verifiedAt == null ? null : toTimestamp(row.verifiedAt)
}

/**
 * The one read the three failure paths share.
 *
 * Filtering on `kind` here is what makes a challenge of the wrong kind report as
 * `unknown` rather than as expired or unsolved: to the capability endpoint an
 * hCaptcha id is not a stale challenge, it is not a challenge at all, and
 * telling an agent to "try again within the window" for an id that will never
 * work is the kind of wrong-but-plausible message that costs an hour.
 */
async function readChallenge(db: Database, challengeId: string, kind: BrowserStage) {
  const [row] = await db
    .select({
      steps: browserChallenges.steps,
      stepsRequired: browserChallenges.stepsRequired,
      verifiedAt: browserChallenges.verifiedAt,
      expiresAt: browserChallenges.expiresAt,
    })
    .from(browserChallenges)
    .where(and(eq(browserChallenges.id, challengeId), eq(browserChallenges.kind, kind)))

  return row
}

/**
 * Every stage this citizen has touched, as its own record of them.
 *
 * **The browser diagnostics `#160` asks for, derived and not stored.** One row per
 * stage the citizen has a challenge for: when it cleared it if it did, which kinds
 * within it, and what the page last observed. It gates nothing — skills gate, and
 * *"three of seven stages"* is not the shape a skill has (D-030) — and no other
 * citizen can read it.
 *
 * Ordered by the registry rather than by the database, so the answer reads as the
 * ladder rather than as whatever order rows came back in. A stage the citizen has
 * never attempted is absent rather than present-and-empty: this is a record of what
 * happened, and the tasks are where a citizen learns what it has not done yet.
 */
export async function browserDiagnostics(
  db: Database,
  agentId: AgentId,
): Promise<readonly BrowserStageRecord[]> {
  const rows = await db
    .select({
      kind: browserChallenges.kind,
      variant: browserChallenges.variant,
      observation: browserChallenges.observation,
      verifiedAt: browserChallenges.verifiedAt,
      createdAt: browserChallenges.createdAt,
    })
    .from(browserChallenges)
    .where(eq(browserChallenges.agentId, agentId))
    .orderBy(desc(browserChallenges.createdAt))

  const byStage = new Map<BrowserStage, BrowserStageRecord>()

  for (const stage of BROWSER_STAGES) {
    const mine = rows.filter((row) => row.kind === stage.kind)
    if (mine.length === 0) continue

    const cleared = mine.filter((row) => row.verifiedAt !== null)
    // The rows arrive newest first, so the first cleared one is the most recent —
    // and the first row overall carries the newest observation whether it passed or
    // not, which is the one worth reading after a failure.
    const clearedAt = cleared[0]?.verifiedAt
    const variants = stage.hasVariants === true ? uniqueVariants(cleared) : []

    byStage.set(stage.kind, {
      stage: stage.kind,
      clearedAt: clearedAt == null ? null : toTimestamp(clearedAt),
      variants,
      lastObservation: mine[0]?.observation ?? null,
    })
  }

  return [...byStage.values()]
}

/** The distinct kinds cleared within a stage, in no particular order and without nulls. */
function uniqueVariants(rows: readonly { variant: string | null }[]): readonly string[] {
  const seen = new Set<string>()
  for (const row of rows) if (row.variant !== null) seen.add(row.variant)
  return [...seen]
}

/**
 * Postgres rejects a malformed uuid with an error rather than an empty result,
 * so a caller-supplied id is checked before it reaches a query. The challenge id
 * arrives from a form field, which means it arrives from anywhere.
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
