import { and, eq, sql } from 'drizzle-orm'
import { type AgentId, type TaskId, type Timestamp } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { tasks } from '../schema/index.js'
import { openAttempt } from './attempts.js'

/**
 * Which task type each kind of challenge is issued for.
 *
 * **This mapping had no home before, and that is the reason this file exists.**
 * No challenge table carries a `task_id`: a challenge is minted for an agent and
 * a kind, and the connection to a task lives only in which verifier reads which
 * table. That was sufficient while nothing needed to count challenges per task —
 * and #108 is exactly the thing that needs to.
 *
 * The alternative was adding `task_id` to eleven challenge tables and eleven
 * mint functions. Rejected: the column would be a second recording of something
 * already implied by the table a row is in, it would be nullable for every
 * historical row anyway, and a mint site that forgot to pass it would produce a
 * challenge belonging to no task rather than a compile error. One exported
 * constant that the type checker keeps exhaustive is the smaller and louder
 * version of the same fact.
 *
 * Keyed by a name for the challenge, not by table name, because
 * `browser_challenges` holds two different rungs distinguished by `kind` —
 * `capability` is the promoting Level 1 rung and `captcha` is an optional badge,
 * and they must never satisfy each other.
 */
export const CHALLENGE_TASK_TYPES = {
  browserCapability: 'browser-capability',
  browserCaptcha: 'browser-captcha',
  email: 'email-roundtrip',
  vision: 'vision-capability',
  image: 'image-gen',
  website: 'website-verify',
  proofOfWork: 'proof-of-work',
  solanaWallet: 'solana-wallet',
  keySignature: 'key-signature',
  github: 'github-account',
  social: 'social-account',
  domain: 'domain-verify',
} as const

export type ChallengeName = keyof typeof CHALLENGE_TASK_TYPES

/**
 * Open an attempt for the task this challenge belongs to.
 *
 * **Never throws and never blocks the mint.** A challenge that could not be
 * counted is still a challenge the agent is entitled to attempt, and the whole
 * feedback programme is instrumentation — instrumentation that can refuse a
 * citizen its rung is worse than no instrumentation. So a task type with no
 * active row (a rung not seeded in this environment, or one retired since)
 * returns `null` and the caller carries on.
 *
 * Idempotent through `openAttempt`: re-minting a challenge inside an attempt
 * that is already open does not start a second one.
 */
export async function openAttemptForChallenge(
  db: Database | Transaction,
  challenge: ChallengeName,
  agentId: AgentId,
  expiresAt: Timestamp | null,
): Promise<TaskId | null> {
  const taskType = CHALLENGE_TASK_TYPES[challenge]

  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.type, taskType), sql`${tasks.status} <> 'draft'`))
    .limit(1)

  if (task === undefined) return null

  const taskId = task.id as TaskId
  await openAttempt(db, { agentId, taskId, opener: 'challenge', expiresAt })
  return taskId
}
