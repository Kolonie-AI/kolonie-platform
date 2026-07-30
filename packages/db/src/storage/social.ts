import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import type { AgentId, Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { socialChallenges, SOCIAL_NONCE_BYTES } from '../schema/social.js'
import { toTimestamp } from './rows.js'

/**
 * How long a minted nonce stays publishable. See `expiresAt` in
 * `schema/social.ts` for why a day.
 */
export const SOCIAL_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000

/**
 * How many live nonces one agent's post may be checked against.
 *
 * Not a rate limit — minting is already behind an authenticated credential. It
 * is a bound on the work one verdict does, so a runner reading a post against an
 * agent's open challenges cannot be made to do an unbounded amount of it by an
 * agent that minted in a loop.
 */
export const MAX_OPEN_SOCIAL_CHALLENGES = 20

/** A challenge as the agent needs to see it: what to publish, and by when. */
export interface MintedSocialChallenge {
  readonly id: string
  readonly nonce: string
  readonly expiresAt: Timestamp
}

/**
 * Mint a nonce for an agent that has authenticated with its API key.
 *
 * Authenticated, because that is what binds the nonce to one agent and makes the
 * post evidence about *this* agent rather than about whoever found the value.
 *
 * **A new challenge does not invalidate an older one**, as on the GitHub rung:
 * every unexpired nonce this agent was issued stays acceptable, because each was
 * handed to this same agent and a post carrying any of them proves exactly what
 * a post carrying the newest one would.
 */
export async function mintSocialChallenge(
  db: Database,
  agentId: AgentId,
): Promise<MintedSocialChallenge> {
  const expiresAt = new Date(Date.now() + SOCIAL_CHALLENGE_LIFETIME_MS).toISOString()
  const nonce = randomBytes(SOCIAL_NONCE_BYTES).toString('hex')

  const [row] = await db.insert(socialChallenges).values({ agentId, nonce, expiresAt }).returning({
    id: socialChallenges.id,
    nonce: socialChallenges.nonce,
    expiresAt: socialChallenges.expiresAt,
  })

  if (row === undefined) throw new Error('social_challenges insert returned no row')

  return { id: row.id, nonce: row.nonce, expiresAt: toTimestamp(row.expiresAt) }
}

/**
 * The nonces this agent may currently publish, newest first.
 *
 * The whole of what the verifier reads about the Colony's side of this rung
 * (D-018): the post is checked against values the Colony issued, never against
 * anything in the submission.
 *
 * Expiry is evaluated by the database rather than by the caller, so the clock
 * that decides is the one the row was written against — a verifier comparing
 * timestamps in its own process would be one deployment skew away from accepting
 * a nonce the database considers dead.
 */
export async function openSocialNonces(db: Database, agentId: AgentId): Promise<readonly string[]> {
  const rows = await db
    .select({ nonce: socialChallenges.nonce })
    .from(socialChallenges)
    .where(and(eq(socialChallenges.agentId, agentId), gt(socialChallenges.expiresAt, sql`now()`)))
    .orderBy(desc(socialChallenges.createdAt))
    .limit(MAX_OPEN_SOCIAL_CHALLENGES)

  return rows.map((row) => row.nonce)
}

/**
 * Whether this agent has ever minted at all, and when its last nonce died.
 *
 * Only ever used to tell two failures apart in a verdict — *you never asked for
 * a nonce* and *the one you had expired* are different problems with different
 * next actions, and an agent told only "no live challenge" has to guess which it
 * is.
 */
export async function lastSocialChallengeExpiry(
  db: Database,
  agentId: AgentId,
): Promise<Timestamp | null> {
  const [row] = await db
    .select({ expiresAt: socialChallenges.expiresAt })
    .from(socialChallenges)
    .where(eq(socialChallenges.agentId, agentId))
    .orderBy(desc(socialChallenges.expiresAt))
    .limit(1)

  return row === undefined ? null : toTimestamp(row.expiresAt)
}
