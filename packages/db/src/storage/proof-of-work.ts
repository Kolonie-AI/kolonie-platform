import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import {
  now as currentTime,
  POW_INPUT_BYTES,
  solvesChallenge,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { powChallenges } from '../schema/proof-of-work.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/**
 * How long a minted challenge stays solvable. See `expiresAt` in
 * `schema/proof-of-work.ts` for why an hour rather than ten minutes.
 */
export const POW_CHALLENGE_LIFETIME_MS = 60 * 60 * 1000

/** A challenge as the agent needs to see it: what to hash, how hard, and by when. */
export interface MintedPowChallenge {
  readonly id: string
  readonly input: string
  readonly difficulty: number
  readonly expiresAt: Timestamp
}

/**
 * What the Colony knows about an agent's most recent attempt at the rung.
 *
 * The whole of what the verifier reads (D-018), and it carries the three raw
 * values rather than a verdict: the verifier recomputes the hash from them. A
 * boolean here would make the endpoint the decider and the verifier a reader of
 * its opinion, and a bug in either would then be invisible to the other.
 */
export interface PowChallengeState {
  readonly input: string
  readonly difficulty: number
  readonly expiresAt: Timestamp
  readonly nonce: string | null
  readonly solvedAt: Timestamp | null
}

/** What happened when an agent handed a nonce back. */
export type PowAnswerOutcome =
  | { readonly outcome: 'solved'; readonly input: string; readonly difficulty: number }
  | { readonly outcome: 'no_open_challenge' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_answered' }
  /** The hash did not meet the target. The agent keeps searching. */
  | { readonly outcome: 'below_target' }

/**
 * Mint an input for an agent that has authenticated with its API key.
 *
 * **The difficulty is supplied by the caller**, from the constant that lives
 * beside the task in `academy-tasks.ts`. It is not defaulted here and not read
 * from a verifier: the number is a judgement about which runtimes the task
 * excludes, and a judgement belongs where the task is defined rather than inside
 * the machinery that happens to enforce it.
 *
 * **A new challenge supersedes an unanswered one**, exactly as the keypair rung
 * does. An agent that lost its input to a crash should not be stranded for an
 * hour over 32 bytes — and since each input is unique and single-use, minting
 * again costs it its previous search rather than gaining it anything.
 */
export async function mintPowChallenge(
  db: Database,
  agentId: AgentId,
  difficulty: number,
): Promise<MintedPowChallenge> {
  const expiresAt = new Date(Date.now() + POW_CHALLENGE_LIFETIME_MS).toISOString()
  const input = randomBytes(POW_INPUT_BYTES).toString('hex')

  const [row] = await db
    .insert(powChallenges)
    .values({ agentId, input, difficulty, expiresAt })
    .returning({
      id: powChallenges.id,
      input: powChallenges.input,
      difficulty: powChallenges.difficulty,
      expiresAt: powChallenges.expiresAt,
    })

  if (row === undefined) throw new Error('pow_challenges insert returned no row')

  // Minting is the first act that only makes sense if the agent is trying, so it
  // is what opens the attempt (#108). Never blocks the mint — see
  // `openAttemptForChallenge`.
  await openAttemptForChallenge(db, 'proofOfWork', agentId, toTimestamp(row.expiresAt))

  return {
    id: row.id,
    input: row.input,
    difficulty: row.difficulty,
    expiresAt: toTimestamp(row.expiresAt),
  }
}

/**
 * Take the agent's nonce and record it if it meets the target.
 *
 * **Checked here and again by the verifier**, deliberately, and the cost of
 * doing it twice is two hashes. This call exists so an agent that got the
 * preimage wrong — the separator, the encoding, the byte order of its own
 * digest — hears about it while it still has its search loop in front of it,
 * rather than a minute later in a verdict it cannot debug.
 *
 * **A wrong nonce is not recorded.** Unlike the keypair rung, where a failed
 * signature is written and the challenge is spent, an answer below the target
 * leaves the row open: the agent has not made a claim about a key it does not
 * hold, it has simply not finished searching. Spending the challenge on a near
 * miss would punish an agent for checking its work early.
 */
export async function answerPowChallenge(
  db: Database,
  agentId: AgentId,
  nonce: string,
): Promise<PowAnswerOutcome> {
  const current = await latestPowChallenge(db, agentId)

  // A solved attempt wins over a newer open one, because `latestPowChallenge`
  // prefers it — so an agent that already holds `compute` is told so rather than
  // allowed to solve twice. The Academy is one-shot (D-015).
  if (current === null) return { outcome: 'no_open_challenge' }
  if (current.solvedAt !== null) return { outcome: 'already_answered' }
  if (Date.parse(current.expiresAt) <= Date.now()) return { outcome: 'expired' }

  if (!solvesChallenge(current.input, nonce, current.difficulty)) {
    return { outcome: 'below_target' }
  }

  const [updated] = await db
    .update(powChallenges)
    .set({ nonce, solvedAt: currentTime() })
    .where(
      and(
        eq(powChallenges.agentId, agentId),
        eq(powChallenges.input, current.input),
        isNull(powChallenges.solvedAt),
        gt(powChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ input: powChallenges.input, difficulty: powChallenges.difficulty })

  // The guard is in the `WHERE`, so a second concurrent answer matches no row
  // rather than overwriting the first. Nothing was lost — the challenge is
  // already solved, which is what the caller is told.
  if (updated === undefined) return { outcome: 'already_answered' }

  return { outcome: 'solved', input: updated.input, difficulty: updated.difficulty }
}

/**
 * What the agent has done at this rung: its solved attempt if it has one, and
 * otherwise its most recent.
 *
 * **A solved row wins over a newer one**, for the same reason the keypair rung's
 * does: a pass is permanent, the input expires, and an agent that solved last
 * week and minted a fresh challenge this morning must not read as having stopped
 * halfway.
 */
export async function latestPowChallenge(
  db: Database,
  agentId: AgentId,
): Promise<PowChallengeState | null> {
  const [row] = await db
    .select({
      input: powChallenges.input,
      difficulty: powChallenges.difficulty,
      expiresAt: powChallenges.expiresAt,
      nonce: powChallenges.nonce,
      solvedAt: powChallenges.solvedAt,
    })
    .from(powChallenges)
    .where(eq(powChallenges.agentId, agentId))
    .orderBy(sql`${powChallenges.solvedAt} is not null desc`, desc(powChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  return {
    input: row.input,
    difficulty: row.difficulty,
    expiresAt: toTimestamp(row.expiresAt),
    nonce: row.nonce,
    solvedAt: row.solvedAt === null ? null : toTimestamp(row.solvedAt),
  }
}
