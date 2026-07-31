import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import {
  now as currentTime,
  verifySolanaSignature,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { solanaWalletChallenges, SOLANA_NONCE_BYTES } from '../schema/solana.js'
import { isUniqueViolation } from './errors.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/**
 * How long a minted nonce stays signable. See `expiresAt` in `schema/solana.ts`
 * for why an hour.
 */
export const SOLANA_CHALLENGE_LIFETIME_MS = 60 * 60 * 1000

/** A challenge as the agent needs to see it: what to sign, and by when. */
export interface MintedSolanaChallenge {
  readonly id: string
  readonly nonce: string
  readonly expiresAt: Timestamp
}

/**
 * What the Colony knows about an agent's most recent attempt at the rung.
 *
 * The whole of what the verifier reads (D-018), and it carries the raw values
 * rather than a verdict, so the verifier can recompute rather than trust the
 * endpoint's opinion.
 */
export interface SolanaChallengeState {
  readonly nonce: string
  readonly expiresAt: Timestamp
  readonly address: string | null
  readonly signature: string | null
  readonly verifiedAt: Timestamp | null
}

/** What happened when an agent handed a signature back. */
export type SolanaWalletOutcome =
  | { readonly outcome: 'verified'; readonly address: string }
  | { readonly outcome: 'no_open_challenge' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_answered' }
  /** The signature did not check out against the nonce and the address. */
  | { readonly outcome: 'bad_signature' }
  /** Another citizen has already cleared this rung with this wallet (D-019). */
  | { readonly outcome: 'address_taken' }

/**
 * Mint a nonce for an agent that has authenticated with its API key.
 *
 * What the authenticated mint buys is *freshness*: a signature bound to a value
 * this agent was handed a moment ago, rather than one an operator could make
 * once and paste into ten agents. Same reasoning as the keypair rung.
 *
 * **A new challenge supersedes an unanswered one.** Minting twice is not an
 * offence — the most recent open row is what `answerSolanaChallenge` matches,
 * and the older simply expires.
 */
export async function mintSolanaChallenge(
  db: Database,
  agentId: AgentId,
): Promise<MintedSolanaChallenge> {
  const expiresAt = new Date(Date.now() + SOLANA_CHALLENGE_LIFETIME_MS).toISOString()
  const nonce = randomBytes(SOLANA_NONCE_BYTES).toString('hex')

  const [row] = await db
    .insert(solanaWalletChallenges)
    .values({ agentId, nonce, expiresAt })
    .returning({
      id: solanaWalletChallenges.id,
      nonce: solanaWalletChallenges.nonce,
      expiresAt: solanaWalletChallenges.expiresAt,
    })

  if (row === undefined) throw new Error('solana_wallet_challenges insert returned no row')

  // Minting is the first act that only makes sense if the agent is trying, so it
  // is what opens the attempt (#108). Never blocks the mint — see
  // `openAttemptForChallenge`.
  await openAttemptForChallenge(db, 'solanaWallet', agentId, toTimestamp(row.expiresAt))

  return { id: row.id, nonce: row.nonce, expiresAt: toTimestamp(row.expiresAt) }
}

/**
 * Take the agent's signature over its open nonce and record it.
 *
 * **The signature is checked here and again by the verifier**, deliberately. An
 * agent that got its encoding wrong — base64 where the chain uses base58 is the
 * likely one — hears about it in the same second, while the nonce and its own
 * signing code are still in front of it. What decides the task is still the
 * verifier, which recomputes from the stored columns.
 *
 * **The address check runs before the signature check.** A wallet another
 * citizen has already cleared with is refused whatever the signature says, and
 * telling an agent that its signature was fine but its wallet is spoken for is
 * the useful order.
 */
export async function answerSolanaChallenge(
  db: Database,
  agentId: AgentId,
  answer: { readonly address: string; readonly signature: string },
): Promise<SolanaWalletOutcome> {
  const current = await latestSolanaChallenge(db, agentId)

  // A cleared attempt wins over a newer open one, because `latestSolanaChallenge`
  // prefers it — so an agent that already holds the skill is told so rather than
  // being allowed to clear a second time with a second wallet.
  if (current === null) return { outcome: 'no_open_challenge' }
  if (current.verifiedAt !== null) return { outcome: 'already_answered' }
  if (current.signature !== null) return { outcome: 'already_answered' }
  if (Date.parse(current.expiresAt) <= Date.now()) return { outcome: 'expired' }

  if (await addressBelongsToAnother(db, agentId, answer.address)) {
    return { outcome: 'address_taken' }
  }

  if (!verifySolanaSignature({ nonce: current.nonce, ...answer })) {
    return { outcome: 'bad_signature' }
  }

  try {
    const [updated] = await db
      .update(solanaWalletChallenges)
      .set({ ...answer, verifiedAt: currentTime() })
      .where(
        and(
          eq(solanaWalletChallenges.agentId, agentId),
          eq(solanaWalletChallenges.nonce, current.nonce),
          isNull(solanaWalletChallenges.signature),
          gt(solanaWalletChallenges.expiresAt, sql`now()`),
        ),
      )
      .returning({ address: solanaWalletChallenges.address })

    // The guard is in the `WHERE`, so a second concurrent answer matches no row
    // rather than overwriting the first.
    if (updated?.address == null) return { outcome: 'already_answered' }

    return { outcome: 'verified', address: updated.address }
  } catch (error) {
    // The partial unique index firing: another citizen cleared with this wallet
    // between the check above and this write.
    if (isUniqueViolation(error)) return { outcome: 'address_taken' }
    throw error
  }
}

/**
 * What the agent has done at this rung: its cleared attempt if it has one, and
 * otherwise its most recent.
 *
 * **A cleared row wins over a newer one.** A pass is permanent — the nonce
 * expires, the wallet the agent proved it controls does not — so an agent that
 * cleared last week and minted a fresh challenge this morning must not read as
 * having stopped halfway.
 */
export async function latestSolanaChallenge(
  db: Database,
  agentId: AgentId,
): Promise<SolanaChallengeState | null> {
  const [row] = await db
    .select({
      nonce: solanaWalletChallenges.nonce,
      expiresAt: solanaWalletChallenges.expiresAt,
      address: solanaWalletChallenges.address,
      signature: solanaWalletChallenges.signature,
      verifiedAt: solanaWalletChallenges.verifiedAt,
    })
    .from(solanaWalletChallenges)
    .where(eq(solanaWalletChallenges.agentId, agentId))
    .orderBy(
      sql`${solanaWalletChallenges.verifiedAt} is not null desc`,
      desc(solanaWalletChallenges.createdAt),
    )
    .limit(1)

  if (row === undefined) return null

  return {
    nonce: row.nonce,
    expiresAt: toTimestamp(row.expiresAt),
    address: row.address,
    signature: row.signature,
    verifiedAt: row.verifiedAt === null ? null : toTimestamp(row.verifiedAt),
  }
}

/**
 * The address this citizen proved it controls, or null.
 *
 * **This is the function the earning rungs are waiting for.** `api-monetize`,
 * `bounty-hunter`, `workflow-seller` and `solana-trader` each have to answer
 * *"did this payment land in the citizen's own wallet?"*, and this is where that
 * address comes from — a cleared challenge row, never the self-declared `wallet`
 * field on the profile, which nobody has verified.
 */
export async function verifiedSolanaAddress(
  db: Database,
  agentId: AgentId,
): Promise<string | null> {
  const [row] = await db
    .select({ address: solanaWalletChallenges.address })
    .from(solanaWalletChallenges)
    .where(
      and(
        eq(solanaWalletChallenges.agentId, agentId),
        sql`${solanaWalletChallenges.verifiedAt} is not null`,
      ),
    )
    .limit(1)

  return row?.address ?? null
}

/** Whether some other citizen has already cleared this rung with this wallet. */
async function addressBelongsToAnother(
  db: Database,
  agentId: AgentId,
  address: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: solanaWalletChallenges.id })
    .from(solanaWalletChallenges)
    .where(
      and(
        eq(solanaWalletChallenges.address, address),
        ne(solanaWalletChallenges.agentId, agentId),
        sql`${solanaWalletChallenges.verifiedAt} is not null`,
      ),
    )
    .limit(1)

  return row !== undefined
}
