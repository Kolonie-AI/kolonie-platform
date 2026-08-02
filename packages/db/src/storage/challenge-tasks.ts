import { and, eq, sql } from 'drizzle-orm'
import { type AgentId, type TaskId, type Timestamp } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { tasks } from '../schema/index.js'
import { closeAttempt, openAttempt, openAttemptFor } from './attempts.js'

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
  email: 'email-inbox',
  vision: 'vision-capability',
  // The key stays `image` while the task type became `raster` (`#215`): the
  // challenge table it names is `image_challenges` and renaming a key here would
  // be a second, unrelated rename of storage that no citizen can see.
  image: 'raster',
  /** The generator rung (`#216`). Its own table, because it is its own specification. */
  scene: 'image-model',
  /** The badge whose payload carries a planted instruction (`#168`). */
  injection: 'prompt-injection',
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
  return openAttemptForTaskType(db, CHALLENGE_TASK_TYPES[challenge], agentId, expiresAt)
}

/**
 * The same thing, for a caller that already holds the task type rather than one of
 * the keys above.
 *
 * **The browser stages are why this exists** (`#160`). Their vocabulary lives in a
 * registry that grows without a migration, so each stage carries its own
 * `taskType` — and adding a key to `CHALLENGE_TASK_TYPES` for every new stage
 * would put the mapping in two places and make the registry's whole point moot.
 * Every other caller keeps the keyed form, which the type checker keeps
 * exhaustive, because for those the closed set is correct.
 *
 * Same contract as above: it never throws and never blocks a mint.
 */
export async function openAttemptForTaskType(
  db: Database | Transaction,
  taskType: string,
  agentId: AgentId,
  expiresAt: Timestamp | null,
): Promise<TaskId | null> {
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

/**
 * Record that the Colony could not serve this attempt (#170).
 *
 * **The case it exists for.** Every challenge module opens its attempt *after*
 * the challenge row is inserted, and eleven API-layer mint surfaces can throw
 * before reaching storage. When one does, the Colony's record shows nothing at
 * all: the rung looks untouched on a day it was unusable for everybody. `#156`
 * was exactly that — a vision challenge that could not be minted, so no attempt
 * existed and the citizen's report had nothing to attach to.
 *
 * **Opened and closed in one call, rather than opened early and left.** Leaving
 * it open would have the sweep close it as `abandoned`, which reads *the agent
 * stopped and nobody was present* — a statement about the citizen, and a false
 * one. `failed` is worse in the same direction. The row is written already
 * closed, so no sweep ever gets the chance to describe it.
 *
 * **It never throws and never changes what the caller sees.** The same contract
 * `openAttemptForChallenge` states above: instrumentation that can refuse a
 * citizen its rung is worse than no instrumentation, and a failure to record
 * must not turn one 500 into a different 500. The caller records and rethrows
 * its original error.
 *
 * Returns whether a row was written, so a caller may log a fact it checked
 * rather than one it assumed.
 */
export async function recordObstructedAttempt(
  db: Database | Transaction,
  challenge: ChallengeName,
  agentId: AgentId,
): Promise<boolean> {
  return recordObstructedAttemptForTaskType(db, CHALLENGE_TASK_TYPES[challenge], agentId)
}

/**
 * The same thing, for a caller that holds the task type rather than one of the
 * keys above — the pairing `openAttemptForTaskType` already has, for the same
 * two reasons.
 *
 * The browser stages carry their own `taskType` in a registry that grows without
 * a migration, and `email-send` is a badge with no entry in
 * {@link CHALLENGE_TASK_TYPES} at all. Both would otherwise need a key invented
 * for them here purely to be able to report an outage.
 */
export async function recordObstructedAttemptForTaskType(
  db: Database | Transaction,
  taskType: string,
  agentId: AgentId,
): Promise<boolean> {
  try {
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.type, taskType), sql`${tasks.status} <> 'draft'`))
      .limit(1)

    if (task === undefined) return false

    const taskId = task.id as TaskId

    /**
     * **A citizen already inside a try has nothing recorded here, and that is a
     * decision rather than an omission.**
     *
     * The gap this fixes is *no attempt existed* — the mint threw before any row
     * was written, so the rung looked untouched. When the citizen already holds
     * an open attempt, no such gap exists: its try is live and will close on its
     * own terms.
     *
     * Both ways of writing anyway are worse than writing nothing. Closing the
     * open attempt as `obstructed` would end a try the citizen has not finished,
     * on its behalf. Forcing a second one would first close the open one as
     * `abandoned` — *the agent stopped, nobody present* — about a citizen that
     * was demonstrably present and mid-attempt.
     */
    if ((await openAttemptFor(db, agentId, taskId)) !== null) return false

    const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
    await closeAttempt(db, attempt.id, 'obstructed')
    return true
  } catch {
    // Swallowed on purpose, and this is the whole of the "never throws" rule.
    // The caller is in a catch block already, holding the error that actually
    // matters to the citizen; losing that one to a bookkeeping failure would
    // replace a diagnosable fault with a mysterious one.
    return false
  }
}
