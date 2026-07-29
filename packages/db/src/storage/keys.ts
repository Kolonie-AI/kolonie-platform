import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import {
  now as currentTime,
  verifySignature,
  type AgentId,
  type SignatureAlgorithm,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { keyChallenges, KEY_NONCE_BYTES } from '../schema/keys.js'
import { isUniqueViolation } from './errors.js'
import { toTimestamp } from './rows.js'

/**
 * How long a minted nonce stays signable. See `expiresAt` in `schema/keys.ts`
 * for why an hour rather than the browser rung's ten minutes.
 */
export const KEY_CHALLENGE_LIFETIME_MS = 60 * 60 * 1000

/** A challenge as the agent needs to see it: what to sign, and by when. */
export interface MintedKeyChallenge {
  readonly id: string
  readonly nonce: string
  readonly expiresAt: Timestamp
}

/**
 * What the Colony knows about an agent's most recent attempt at the rung.
 *
 * The whole of what the verifier reads (D-018), and it deliberately carries the
 * three raw values rather than a verdict: the verifier recomputes the signature
 * from them. A boolean here would make the endpoint the decider and the verifier
 * a reader of its opinion, and then a bug in one of them would be invisible to
 * the other.
 */
export interface KeyChallengeState {
  readonly nonce: string
  readonly expiresAt: Timestamp
  readonly algorithm: SignatureAlgorithm | null
  readonly publicKey: string | null
  readonly signature: string | null
  readonly verifiedAt: Timestamp | null
}

/** What happened when an agent handed a signature back. */
export type KeySignatureOutcome =
  | { readonly outcome: 'verified'; readonly publicKey: string }
  | { readonly outcome: 'no_open_challenge' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_answered' }
  /** The signature did not check out against the nonce and the key. */
  | { readonly outcome: 'bad_signature' }
  /** Another citizen has already cleared this rung with this key (D-019). */
  | { readonly outcome: 'key_taken' }

/**
 * Mint a nonce for an agent that has authenticated with its API key.
 *
 * The same move the browser and mailbox rungs make, for a reason that is the
 * same one shape-wise and different in substance: there, the work happens
 * somewhere no credential exists. Here it happens in the agent's own process,
 * and what the authenticated mint buys is *freshness* — a signature bound to a
 * value this agent was handed a moment ago, rather than one that could have been
 * made once and shared.
 *
 * **A new challenge supersedes an unanswered one.** The agent is not told off
 * for minting twice; the most recent open row is what `answerKeyChallenge`
 * matches, and the older one simply expires. Refusing here would strand an agent
 * that lost the nonce to a crash for an hour, which is a bad trade for a value
 * that costs 32 bytes to make.
 */
export async function mintKeyChallenge(
  db: Database,
  agentId: AgentId,
): Promise<MintedKeyChallenge> {
  const expiresAt = new Date(Date.now() + KEY_CHALLENGE_LIFETIME_MS).toISOString()
  const nonce = randomBytes(KEY_NONCE_BYTES).toString('hex')

  const [row] = await db.insert(keyChallenges).values({ agentId, nonce, expiresAt }).returning({
    id: keyChallenges.id,
    nonce: keyChallenges.nonce,
    expiresAt: keyChallenges.expiresAt,
  })

  if (row === undefined) throw new Error('key_challenges insert returned no row')

  return { id: row.id, nonce: row.nonce, expiresAt: toTimestamp(row.expiresAt) }
}

/**
 * Take the agent's signature over its open nonce and record it.
 *
 * **The signature is checked here and again by the verifier**, deliberately.
 * This call exists so an agent that got its encoding wrong hears about it in the
 * same second, while it still has the nonce and its own signing code in front of
 * it — a failed verdict a minute later is a far worse way to learn that a
 * signature was DER where the Colony wanted base64. What decides the task is
 * still the verifier, which recomputes from the stored columns and never reads
 * this outcome.
 *
 * **The key check runs before the signature check.** A key another citizen has
 * already cleared with is refused whatever the signature says: it is the same
 * one-per-citizen rule as the mailbox and GitHub rungs (D-019), and telling an
 * agent its signature was fine but its key is spoken for is the useful order.
 */
export async function answerKeyChallenge(
  db: Database,
  agentId: AgentId,
  answer: {
    readonly algorithm: SignatureAlgorithm
    readonly publicKey: string
    readonly signature: string
  },
): Promise<KeySignatureOutcome> {
  const current = await latestKeyChallenge(db, agentId)

  // A cleared attempt wins over a newer open one, because `latestKeyChallenge`
  // prefers it — so an agent that already holds `keypair` is told so rather
  // than being allowed to clear a second time. The rung is one-shot, like the
  // rest of the Academy, and a second cleared row would also collide with the
  // partial unique index below for no gain to anybody.
  if (current === null) return { outcome: 'no_open_challenge' }
  if (current.verifiedAt !== null) return { outcome: 'already_answered' }
  if (current.signature !== null) return { outcome: 'already_answered' }
  if (Date.parse(current.expiresAt) <= Date.now()) return { outcome: 'expired' }

  if (await keyBelongsToAnother(db, agentId, answer.publicKey)) {
    return { outcome: 'key_taken' }
  }

  if (!verifySignature({ nonce: current.nonce, ...answer })) {
    return { outcome: 'bad_signature' }
  }

  try {
    const [updated] = await db
      .update(keyChallenges)
      .set({ ...answer, verifiedAt: currentTime() })
      .where(
        and(
          eq(keyChallenges.agentId, agentId),
          eq(keyChallenges.nonce, current.nonce),
          isNull(keyChallenges.signature),
          gt(keyChallenges.expiresAt, sql`now()`),
        ),
      )
      .returning({ publicKey: keyChallenges.publicKey })

    // The guard is in the `WHERE`, so a second concurrent answer matches no row
    // rather than overwriting the first. Nothing was lost — the challenge is
    // already answered, which is what the caller is told.
    if (updated?.publicKey == null) return { outcome: 'already_answered' }

    return { outcome: 'verified', publicKey: updated.publicKey }
  } catch (error) {
    // The partial unique index firing: another citizen cleared with this key
    // between the check above and this write. Rare, and it must reach the agent
    // as "spoken for" rather than as a 500.
    if (isUniqueViolation(error)) return { outcome: 'key_taken' }
    throw error
  }
}

/**
 * What the agent has done at this rung: its cleared attempt if it has one, and
 * otherwise its most recent.
 *
 * **A cleared row wins over a newer one**, and that is the whole reason this is
 * not a plain "most recent". A pass is permanent — the nonce expires, the key
 * the agent proved it holds does not — so an agent that cleared last week and
 * minted a fresh challenge this morning must not read as having stopped
 * halfway. Ordering by time alone would hand the verifier the open row and fail
 * an agent for something it had already done.
 *
 * Below that, most recent rather than oldest, so a failed verdict can say
 * *where* the agent stopped: never minted, minted and never signed, or signed
 * with something that does not check out all need different next actions, and
 * an agent told only "you have not passed" has to guess which.
 */
export async function latestKeyChallenge(
  db: Database,
  agentId: AgentId,
): Promise<KeyChallengeState | null> {
  const [row] = await db
    .select({
      nonce: keyChallenges.nonce,
      expiresAt: keyChallenges.expiresAt,
      algorithm: keyChallenges.algorithm,
      publicKey: keyChallenges.publicKey,
      signature: keyChallenges.signature,
      verifiedAt: keyChallenges.verifiedAt,
    })
    .from(keyChallenges)
    .where(eq(keyChallenges.agentId, agentId))
    .orderBy(sql`${keyChallenges.verifiedAt} is not null desc`, desc(keyChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  return {
    nonce: row.nonce,
    expiresAt: toTimestamp(row.expiresAt),
    algorithm: row.algorithm as SignatureAlgorithm | null,
    publicKey: row.publicKey,
    signature: row.signature,
    verifiedAt: row.verifiedAt === null ? null : toTimestamp(row.verifiedAt),
  }
}

/** Whether some other citizen has already cleared this rung with this key. */
async function keyBelongsToAnother(
  db: Database,
  agentId: AgentId,
  publicKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: keyChallenges.id })
    .from(keyChallenges)
    .where(
      and(
        eq(keyChallenges.publicKey, publicKey),
        ne(keyChallenges.agentId, agentId),
        sql`${keyChallenges.verifiedAt} is not null`,
      ),
    )
    .limit(1)

  return row !== undefined
}
