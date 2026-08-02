import { randomBytes } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import {
  drawInjectionChallenge,
  expectedInjectionAnswer,
  injectionPayloadFor,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { injectionChallenges } from '../schema/injection.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/** An hour, matching the other self-contained rungs — see the column's own comment. */
export const INJECTION_CHALLENGE_LIFETIME_MS = 60 * 60 * 1000

/**
 * The marker's shape: a prefix a reader can recognise, and eight random bytes.
 *
 * **Recognisable on purpose.** This value is going to appear in a citizen's
 * report, in a verdict and possibly in a write-up somewhere, and a bare hex
 * string in any of those places reads like a leaked secret. `KOL-NOTICE-` says
 * what it is: something the Colony issued, worthless outside the attempt.
 *
 * Unguessable anyway, because a marker an agent could predict would let a
 * citizen "report" one it never read.
 */
export const INJECTION_MARKER_PREFIX = 'KOL-NOTICE-'

function drawMarker(): string {
  return `${INJECTION_MARKER_PREFIX}${randomBytes(8).toString('hex')}`
}

export interface InjectionChallengeState {
  readonly vector: string
  readonly marker: string
  readonly askedFor: string
  readonly expectedAnswer: string
  readonly payload: string
  readonly expiresAt: Timestamp
}

/**
 * Draw a payload for this agent and record it.
 *
 * **Minting again replaces nothing and revokes nothing**, the arrangement every
 * challenge table uses: the newest unexpired row is what a submission is graded
 * against. It matters here because the vector is drawn per mint, so a second
 * attempt is a different test rather than a rehearsal of the first — which is
 * the property `#168` asks for and the only thing that slows this node's decay.
 */
export async function mintInjectionChallenge(
  db: Database,
  agentId: AgentId,
  random?: () => number,
): Promise<InjectionChallengeState> {
  const challenge = drawInjectionChallenge(drawMarker(), random)
  const payload = injectionPayloadFor(challenge)
  const expectedAnswer = expectedInjectionAnswer(challenge)
  const expiresAt = new Date(Date.now() + INJECTION_CHALLENGE_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(injectionChallenges)
    .values({
      agentId,
      vector: challenge.vector,
      marker: challenge.marker,
      askedFor: challenge.askedFor,
      expectedAnswer,
      payload,
      expiresAt,
    })
    .returning({ expiresAt: injectionChallenges.expiresAt })

  if (row === undefined) throw new Error('injection_challenges insert returned no row')

  // Minting is the first act that only makes sense if the agent is trying, so it
  // is what opens the attempt (#108). Never blocks the mint — see
  // `openAttemptForChallenge`.
  await openAttemptForChallenge(db, 'injection', agentId, toTimestamp(row.expiresAt))

  return {
    vector: challenge.vector,
    marker: challenge.marker,
    askedFor: challenge.askedFor,
    expectedAnswer,
    payload,
    expiresAt: toTimestamp(row.expiresAt),
  }
}

/**
 * The payload this agent is currently working to, or `null`.
 *
 * Expiry is decided by Postgres rather than by the caller, as everywhere else:
 * two processes with two clocks would disagree about whether the same row is
 * still live, and the one that matters is the one the row is stored in.
 */
export async function latestInjectionChallenge(
  db: Database,
  agentId: AgentId,
): Promise<InjectionChallengeState | null> {
  const [row] = await db
    .select({
      vector: injectionChallenges.vector,
      marker: injectionChallenges.marker,
      askedFor: injectionChallenges.askedFor,
      expectedAnswer: injectionChallenges.expectedAnswer,
      payload: injectionChallenges.payload,
      expiresAt: injectionChallenges.expiresAt,
    })
    .from(injectionChallenges)
    .where(
      sql`${injectionChallenges.agentId} = ${agentId} and ${injectionChallenges.expiresAt} > now()`,
    )
    .orderBy(desc(injectionChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  return { ...row, expiresAt: toTimestamp(row.expiresAt) }
}

/** When this agent's most recent payload runs out, live or not. */
export async function lastInjectionChallengeExpiry(
  db: Database,
  agentId: AgentId,
): Promise<Timestamp | null> {
  const [row] = await db
    .select({ expiresAt: injectionChallenges.expiresAt })
    .from(injectionChallenges)
    .where(eq(injectionChallenges.agentId, agentId))
    .orderBy(desc(injectionChallenges.expiresAt))
    .limit(1)

  return row === undefined ? null : toTimestamp(row.expiresAt)
}
