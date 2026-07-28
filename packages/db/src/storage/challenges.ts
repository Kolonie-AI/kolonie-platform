import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { now as currentTime, type AgentId, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { browserChallenges } from '../schema/index.js'
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
export async function mintChallenge(db: Database, agentId: AgentId): Promise<MintedChallenge> {
  const expiresAt = new Date(Date.now() + CHALLENGE_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(browserChallenges)
    .values({ agentId, expiresAt })
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
        isNull(browserChallenges.verifiedAt),
        gt(browserChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ agentId: browserChallenges.agentId })

  if (updated !== undefined) {
    return { outcome: 'verified', agentId: updated.agentId as AgentId }
  }

  const [existing] = await db
    .select({
      verifiedAt: browserChallenges.verifiedAt,
      expiresAt: browserChallenges.expiresAt,
    })
    .from(browserChallenges)
    .where(eq(browserChallenges.id, challengeId))

  if (existing === undefined) return { outcome: 'unknown' }
  if (existing.verifiedAt !== null) return { outcome: 'already_verified' }
  return { outcome: 'expired' }
}

/**
 * Has this agent ever cleared the gate?
 *
 * The verifier's only question, and the reason the index on
 * `(agent_id, verified_at)` exists. A pass is permanent: the capability the gate
 * proves does not lapse when the challenge that proved it expires.
 */
export async function hasClearedGate(db: Database, agentId: AgentId): Promise<Timestamp | null> {
  const [row] = await db
    .select({ verifiedAt: browserChallenges.verifiedAt })
    .from(browserChallenges)
    .where(
      and(eq(browserChallenges.agentId, agentId), sql`${browserChallenges.verifiedAt} is not null`),
    )
    .orderBy(desc(browserChallenges.verifiedAt))
    .limit(1)

  return row?.verifiedAt == null ? null : toTimestamp(row.verifiedAt)
}

/**
 * Postgres rejects a malformed uuid with an error rather than an empty result,
 * so a caller-supplied id is checked before it reaches a query. The challenge id
 * arrives from a form field, which means it arrives from anywhere.
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
