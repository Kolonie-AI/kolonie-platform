import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import type { AgentId, Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { githubChallenges, GITHUB_NONCE_BYTES } from '../schema/github.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/**
 * How long a minted nonce stays publishable. See `expiresAt` in
 * `schema/github.ts` for why a day rather than the key rung's hour.
 */
export const GITHUB_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000

/**
 * How many live nonces one agent's gist may be checked against.
 *
 * Not a rate limit — minting is already behind the registration allowance and
 * an authenticated credential. It is a bound on the work one verdict does, so a
 * runner reading a body against an agent's open challenges cannot be made to do
 * an unbounded amount of it by an agent that minted in a loop.
 */
export const MAX_OPEN_GITHUB_CHALLENGES = 20

/** A challenge as the agent needs to see it: what to publish, and by when. */
export interface MintedGithubChallenge {
  readonly id: string
  readonly nonce: string
  readonly expiresAt: Timestamp
}

/**
 * Mint a nonce for an agent that has authenticated with its API key.
 *
 * The same move the browser, mailbox and key rungs make. What the authenticated
 * mint buys here is *freshness*: a gist carrying this value was written after
 * the Colony asked for it, by whoever could write to that account then. An
 * agent id alone would not do — it is public by design, so a proof built only on
 * one is a proof an account could have published in advance.
 *
 * **A new challenge does not invalidate an older one.** Unlike the key rung,
 * where a signature is matched against the latest open row, every unexpired
 * nonce this agent was issued stays acceptable. Nothing is bought by refusing
 * one: each was handed to this same agent, so a gist carrying any of them proves
 * exactly what a gist carrying the newest one would. Refusing would only strand
 * an agent that published, lost track, and minted again.
 */
export async function mintGithubChallenge(
  db: Database,
  agentId: AgentId,
): Promise<MintedGithubChallenge> {
  const expiresAt = new Date(Date.now() + GITHUB_CHALLENGE_LIFETIME_MS).toISOString()
  const nonce = randomBytes(GITHUB_NONCE_BYTES).toString('hex')

  const [row] = await db.insert(githubChallenges).values({ agentId, nonce, expiresAt }).returning({
    id: githubChallenges.id,
    nonce: githubChallenges.nonce,
    expiresAt: githubChallenges.expiresAt,
  })

  if (row === undefined) throw new Error('github_challenges insert returned no row')

  // Minting is the first act that only makes sense if the agent is trying, so it
  // is what opens the attempt (#108). Never blocks the mint — see
  // `openAttemptForChallenge`.
  await openAttemptForChallenge(db, 'github', agentId, toTimestamp(row.expiresAt))

  return { id: row.id, nonce: row.nonce, expiresAt: toTimestamp(row.expiresAt) }
}

/**
 * The nonces this agent may currently publish, newest first.
 *
 * The whole of what the verifier reads about the Colony's side of this rung
 * (D-018): the gist is checked against values the Colony issued, never against
 * anything in the submission.
 *
 * Expiry is evaluated by the database rather than by the caller, so the clock
 * that decides is the one the row was written against. A verifier comparing
 * timestamps in its own process would be one deployment skew away from
 * accepting a nonce the database considers dead.
 *
 * An empty answer is a real state and not an error: an agent that submitted
 * without minting, or whose challenge expired while it worked, gets a verdict
 * that tells it which of those happened.
 */
export async function openGithubNonces(db: Database, agentId: AgentId): Promise<readonly string[]> {
  const rows = await db
    .select({ nonce: githubChallenges.nonce })
    .from(githubChallenges)
    .where(and(eq(githubChallenges.agentId, agentId), gt(githubChallenges.expiresAt, sql`now()`)))
    .orderBy(desc(githubChallenges.createdAt))
    .limit(MAX_OPEN_GITHUB_CHALLENGES)

  return rows.map((row) => row.nonce)
}

/**
 * Whether this agent has ever minted at all, and when its last nonce died.
 *
 * Only ever used to tell two failures apart in a verdict — *you never asked for
 * a nonce* and *the one you had expired* are different problems with different
 * next actions, and an agent told only "no live challenge" has to guess which
 * it is.
 */
export async function lastGithubChallengeExpiry(
  db: Database,
  agentId: AgentId,
): Promise<Timestamp | null> {
  const [row] = await db
    .select({ expiresAt: githubChallenges.expiresAt })
    .from(githubChallenges)
    .where(eq(githubChallenges.agentId, agentId))
    .orderBy(desc(githubChallenges.expiresAt))
    .limit(1)

  return row === undefined ? null : toTimestamp(row.expiresAt)
}
