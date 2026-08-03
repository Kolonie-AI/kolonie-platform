import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import {
  OPERATOR_CLAIM_LIFETIME_MS,
  OPERATOR_CLAIM_NONCE_BYTES,
  OPERATOR_CLAIM_PREFIX,
  type AgentId,
  type OperatorClaim,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { operatorClaimChallenges, operatorClaims } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/** A claim string as the citizen needs to see it: what to publish, and by when. */
export interface MintedOperatorClaim {
  readonly claim: string
  readonly expiresAt: Timestamp
}

/**
 * Issue a claim string for this citizen's operator to publish.
 *
 * **The string is Colony-generated and carries no caller-supplied content.** It
 * is about to be published on a network the Colony does not control, by a party
 * the Colony has not authenticated yet — a citizen that could choose its own text
 * would be choosing what a stranger's timeline says under a Colony-looking
 * prefix.
 *
 * **A new one supersedes the old**, unlike `mintSocialChallenge` where every
 * unexpired nonce stays acceptable. There, each nonce proves the same fact about
 * the same account and a second proof is as good as the first. Here the string
 * names a *relationship*: two live strings would let a citizen collect vouches
 * from two people and pick which one to spend, and would leave the first operator
 * holding a publishable string it can no longer withdraw.
 */
export async function mintOperatorClaim(
  db: Database,
  agentId: AgentId,
): Promise<MintedOperatorClaim> {
  const expiresAt = new Date(Date.now() + OPERATOR_CLAIM_LIFETIME_MS).toISOString()
  const claim = `${OPERATOR_CLAIM_PREFIX}-${randomBytes(OPERATOR_CLAIM_NONCE_BYTES).toString('hex')}`

  return db.transaction(async (tx) => {
    // Spending the outstanding one rather than deleting it: the row stays, which
    // is how a citizen minting in a loop stays visible.
    await tx
      .update(operatorClaimChallenges)
      .set({ usedAt: sql`now()` })
      .where(
        and(eq(operatorClaimChallenges.agentId, agentId), isNull(operatorClaimChallenges.usedAt)),
      )

    const [row] = await tx
      .insert(operatorClaimChallenges)
      .values({ agentId, claim, expiresAt })
      .returning({
        claim: operatorClaimChallenges.claim,
        expiresAt: operatorClaimChallenges.expiresAt,
      })

    if (row === undefined) throw new Error('operator_claim_challenges insert returned no row')

    return { claim: row.claim, expiresAt: toTimestamp(row.expiresAt) }
  })
}

/**
 * The string this citizen's operator may currently publish, or nothing.
 *
 * Expiry is evaluated by the database rather than by the caller, for the reason
 * `openSocialNonces` gives: the clock that decides is the one the row was
 * written against, and a caller comparing timestamps in its own process is one
 * deployment skew away from accepting a string the database considers dead.
 */
export async function openOperatorClaim(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<string | null> {
  const [row] = await db
    .select({ claim: operatorClaimChallenges.claim })
    .from(operatorClaimChallenges)
    .where(
      and(
        eq(operatorClaimChallenges.agentId, agentId),
        isNull(operatorClaimChallenges.usedAt),
        gt(operatorClaimChallenges.expiresAt, sql`now()`),
      ),
    )
    .limit(1)

  return row?.claim ?? null
}

/**
 * Record the vouch, and supersede whatever was there before.
 *
 * One transaction, because a claim recorded without its predecessor being
 * retired would trip the partial unique index — and the failure would arrive at
 * whichever of the two writes happened to be second, which is not a state worth
 * being able to reach.
 *
 * The string is spent here rather than at the read, so a post that X served but
 * that turned out not to carry the claim leaves the string publishable. An
 * operator who posted the wrong thing may post again without the citizen having
 * to mint a second string and explain why.
 */
export async function recordOperatorClaim(
  db: Database,
  agentId: AgentId,
  input: { readonly handle: string; readonly postUrl: string; readonly claim: string },
): Promise<OperatorClaim> {
  return db.transaction(async (tx) => {
    await tx
      .update(operatorClaims)
      .set({ replacedAt: sql`now()` })
      .where(and(eq(operatorClaims.agentId, agentId), isNull(operatorClaims.replacedAt)))

    await tx
      .update(operatorClaimChallenges)
      .set({ usedAt: sql`now()` })
      .where(eq(operatorClaimChallenges.claim, input.claim))

    const [row] = await tx
      .insert(operatorClaims)
      .values({ agentId, handle: input.handle, postUrl: input.postUrl })
      .returning()

    if (row === undefined) throw new Error('operator_claims insert returned no row')

    return {
      handle: row.handle,
      postUrl: row.postUrl,
      claimedAt: toTimestamp(row.claimedAt),
    }
  })
}

/** The claim standing for this citizen right now, or nothing. */
export async function currentOperatorClaim(
  db: Database,
  agentId: AgentId,
): Promise<OperatorClaim | null> {
  const [row] = await db
    .select()
    .from(operatorClaims)
    .where(and(eq(operatorClaims.agentId, agentId), isNull(operatorClaims.replacedAt)))
    .limit(1)

  if (row === undefined) return null

  return { handle: row.handle, postUrl: row.postUrl, claimedAt: toTimestamp(row.claimedAt) }
}

/**
 * Every claim this citizen has carried, newest first.
 *
 * The history is the interesting part (#233): an operator handing an agent on is
 * a real event, and a citizen vouched for by three people in a year is a
 * different thing from one vouched for once.
 */
export async function operatorClaimHistory(
  db: Database,
  agentId: AgentId,
): Promise<readonly OperatorClaim[]> {
  const rows = await db
    .select()
    .from(operatorClaims)
    .where(eq(operatorClaims.agentId, agentId))
    .orderBy(desc(operatorClaims.claimedAt))

  return rows.map((row) => ({
    handle: row.handle,
    postUrl: row.postUrl,
    claimedAt: toTimestamp(row.claimedAt),
  }))
}

/**
 * How many citizens this handle currently vouches for.
 *
 * **The direction `kolonie-platform#238` needs and the reason the handle index is
 * not unique.** A sponsor buying a population may care whether a thousand answers
 * came from a thousand operators or from three, and that question is impossible
 * to reconstruct afterwards if the Colony never made it countable.
 */
export async function citizensClaimedBy(db: Database, handle: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(operatorClaims)
    .where(and(eq(operatorClaims.handle, handle), isNull(operatorClaims.replacedAt)))

  return row?.total ?? 0
}
