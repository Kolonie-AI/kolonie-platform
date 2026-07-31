import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import type { AgentId, Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { domainChallenges, DOMAIN_NONCE_BYTES } from '../schema/domain.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/**
 * How long a minted nonce stays publishable. See `expiresAt` in
 * `schema/domain.ts` for what the day covers, which is not what it covers on the
 * rungs either side.
 */
export const DOMAIN_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000

/**
 * How many live nonces one agent's zone may be checked against.
 *
 * Not a rate limit — minting is already behind an authenticated credential. It
 * is a bound on the work one verdict does, so a runner reading a `TXT` set
 * against an agent's open challenges cannot be made to do an unbounded amount of
 * it by an agent that minted in a loop.
 */
export const MAX_OPEN_DOMAIN_CHALLENGES = 20

/** A challenge as the agent needs to see it: what to publish, and by when. */
export interface MintedDomainChallenge {
  readonly id: string
  readonly nonce: string
  readonly expiresAt: Timestamp
}

/**
 * Mint a nonce for an agent that has authenticated with its API key.
 *
 * Authenticated, because that is what binds the nonce to one agent and makes the
 * record evidence about *this* agent rather than about whoever found the value.
 *
 * **A new challenge does not invalidate an older one**, as on the rungs either
 * side: every unexpired nonce this agent was issued stays acceptable, because
 * each was handed to this same agent and a record carrying any of them proves
 * exactly what a record carrying the newest one would.
 */
export async function mintDomainChallenge(
  db: Database,
  agentId: AgentId,
): Promise<MintedDomainChallenge> {
  const expiresAt = new Date(Date.now() + DOMAIN_CHALLENGE_LIFETIME_MS).toISOString()
  const nonce = randomBytes(DOMAIN_NONCE_BYTES).toString('hex')

  const [row] = await db.insert(domainChallenges).values({ agentId, nonce, expiresAt }).returning({
    id: domainChallenges.id,
    nonce: domainChallenges.nonce,
    expiresAt: domainChallenges.expiresAt,
  })

  if (row === undefined) throw new Error('domain_challenges insert returned no row')

  // Minting is the first act that only makes sense if the agent is trying, so it
  // is what opens the attempt (#108). Never blocks the mint — see
  // `openAttemptForChallenge`.
  await openAttemptForChallenge(db, 'domain', agentId, toTimestamp(row.expiresAt))

  return { id: row.id, nonce: row.nonce, expiresAt: toTimestamp(row.expiresAt) }
}

/**
 * The nonces this agent may currently publish, newest first.
 *
 * The whole of what the verifier reads about the Colony's side of this rung
 * (D-018): the record is checked against values the Colony issued, never against
 * anything in the submission.
 *
 * Expiry is evaluated by the database rather than by the caller, so the clock
 * that decides is the one the row was written against — a verifier comparing
 * timestamps in its own process would be one deployment skew away from accepting
 * a nonce the database considers dead.
 */
export async function openDomainNonces(db: Database, agentId: AgentId): Promise<readonly string[]> {
  const rows = await db
    .select({ nonce: domainChallenges.nonce })
    .from(domainChallenges)
    .where(and(eq(domainChallenges.agentId, agentId), gt(domainChallenges.expiresAt, sql`now()`)))
    .orderBy(desc(domainChallenges.createdAt))
    .limit(MAX_OPEN_DOMAIN_CHALLENGES)

  return rows.map((row) => row.nonce)
}

/**
 * When this agent's most recent challenge expires or expired, or `null` if it
 * never minted one.
 *
 * Read only to tell two failures apart in the evidence — never minted, versus
 * minted and left too long. Those have different next actions and an agent told
 * only "no live challenge" would have to guess which it is.
 */
export async function lastDomainExpiry(db: Database, agentId: AgentId): Promise<Timestamp | null> {
  const [row] = await db
    .select({ expiresAt: domainChallenges.expiresAt })
    .from(domainChallenges)
    .where(eq(domainChallenges.agentId, agentId))
    .orderBy(desc(domainChallenges.createdAt))
    .limit(1)

  return row === undefined ? null : toTimestamp(row.expiresAt)
}
