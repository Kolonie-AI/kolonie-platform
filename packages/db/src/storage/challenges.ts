import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { now as currentTime, type AgentId, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { browserChallenges, CAPABILITY_STEPS, type ChallengeKind } from '../schema/index.js'
import { toTimestamp } from './rows.js'

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

/** What the page is allowed to know about a challenge before it starts working. */
export type ChallengeProgress =
  | { readonly outcome: 'open'; readonly steps: number; readonly total: number }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_verified' }

/** The result of reporting one step of a capability challenge. */
export type StepOutcome =
  | { readonly outcome: 'advanced'; readonly steps: number; readonly total: number }
  | { readonly outcome: 'cleared'; readonly agentId: AgentId }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_verified' }
  | { readonly outcome: 'out_of_order'; readonly steps: number }

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
  kind: ChallengeKind,
): Promise<MintedChallenge> {
  const expiresAt = new Date(Date.now() + CHALLENGE_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(browserChallenges)
    .values({ agentId, expiresAt, kind })
    .returning({ id: browserChallenges.id, expiresAt: browserChallenges.expiresAt })

  if (row === undefined) throw new Error('browser_challenges insert returned no row')

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
        eq(browserChallenges.kind, 'captcha'),
        isNull(browserChallenges.verifiedAt),
        gt(browserChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ agentId: browserChallenges.agentId })

  if (updated !== undefined) {
    return { outcome: 'verified', agentId: updated.agentId as AgentId }
  }

  const existing = await readChallenge(db, challengeId, 'captcha')

  if (existing === undefined) return { outcome: 'unknown' }
  if (existing.verifiedAt !== null) return { outcome: 'already_verified' }
  return { outcome: 'expired' }
}

/**
 * What the page may know about a capability challenge before it starts.
 *
 * It is told how many steps are done and how many there are, and nothing else —
 * not the agent, not the expiry as a wall-clock value. The page is a public
 * surface reached with a bearer id; it gets what it needs to draw itself.
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

  const row = await readChallenge(db, challengeId, 'capability')

  if (row === undefined) return { outcome: 'unknown' }
  if (row.verifiedAt !== null) return { outcome: 'already_verified' }
  if (Date.parse(row.expiresAt) <= Date.now()) return { outcome: 'expired' }

  return { outcome: 'open', steps: row.steps, total: CAPABILITY_STEPS }
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
): Promise<StepOutcome> {
  if (!isUuid(challengeId)) return { outcome: 'unknown' }

  const completed = fromStep + 1
  const clears = completed >= CAPABILITY_STEPS

  const [updated] = await db
    .update(browserChallenges)
    .set({ steps: completed, ...(clears ? { verifiedAt: currentTime() } : {}) })
    .where(
      and(
        eq(browserChallenges.id, challengeId),
        eq(browserChallenges.kind, 'capability'),
        eq(browserChallenges.steps, fromStep),
        isNull(browserChallenges.verifiedAt),
        gt(browserChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ agentId: browserChallenges.agentId })

  if (updated !== undefined) {
    return clears
      ? { outcome: 'cleared', agentId: updated.agentId as AgentId }
      : { outcome: 'advanced', steps: completed, total: CAPABILITY_STEPS }
  }

  const existing = await readChallenge(db, challengeId, 'capability')

  if (existing === undefined) return { outcome: 'unknown' }
  if (existing.verifiedAt !== null) return { outcome: 'already_verified' }
  if (Date.parse(existing.expiresAt) <= Date.now()) return { outcome: 'expired' }
  return { outcome: 'out_of_order', steps: existing.steps }
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
  kind: ChallengeKind,
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
async function readChallenge(db: Database, challengeId: string, kind: ChallengeKind) {
  const [row] = await db
    .select({
      steps: browserChallenges.steps,
      verifiedAt: browserChallenges.verifiedAt,
      expiresAt: browserChallenges.expiresAt,
    })
    .from(browserChallenges)
    .where(and(eq(browserChallenges.id, challengeId), eq(browserChallenges.kind, kind)))

  return row
}

/**
 * Postgres rejects a malformed uuid with an error rather than an empty result,
 * so a caller-supplied id is checked before it reaches a query. The challenge id
 * arrives from a form field, which means it arrives from anywhere.
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
