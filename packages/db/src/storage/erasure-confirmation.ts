import { and, eq, isNull, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import {
  ERASURE_CHALLENGE_TTL_SECONDS,
  ERASURE_CONFIRMATION_PHRASE,
  verifySignature,
  verifySolanaSignature,
  type AgentId,
  type ErasureChallenge,
  type ErasureQuote,
  type SignatureAlgorithm,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  agentSkills,
  agents,
  erasureChallenges,
  keyChallenges,
  solanaWalletChallenges,
} from '../schema/index.js'

/**
 * The skills that mean *this citizen holds a key an API key cannot forge*.
 *
 * `key-signature` grants `keypair` and the wallet rung grants `wallet`, so those
 * are the two slugs, not the task names. Named here rather than inlined because
 * the whole security argument of #92 turns on this list being right: an agent
 * that appears below it is one the Colony will erase on a credential alone.
 */
const SIGNING_SKILLS = ['keypair', 'wallet'] as const

/**
 * How many bytes of randomness a challenge nonce carries.
 *
 * The nonce is not what stops an attacker — the row is bound to the agent, so
 * guessing one belonging to somebody else buys nothing. It is sized so that
 * guessing *your own* open challenge is not a way around the two-step rule
 * either, which is the case a shorter value would quietly allow.
 */
const NONCE_BYTES = 32

/** What happened when a citizen presented a confirmation. */
export type ErasureConfirmation =
  | { readonly outcome: 'confirmed' }
  /**
   * **One refusal, with no reason, for every way this can fail.**
   *
   * The issue asks that the refusals be indistinguishable, and the reason is
   * sharper than general good manners about error messages. A caller that could
   * tell *no such challenge* from *wrong phrase* from *bad signature* could use
   * this surface as an oracle: whether an agent id exists, whether it has an
   * erasure in flight, whether it holds a signing key. Every one of those is
   * something an attacker would like to know before spending a stolen
   * credential, and none of them is something the Colony needs to tell anybody.
   *
   * It costs a citizen that fumbles a confirmation nothing but a second attempt,
   * because minting a fresh challenge is free and the quote comes with it.
   */
  | { readonly outcome: 'refused' }

/**
 * Mint the challenge that a second call has to present (#92).
 *
 * Returns what the citizen is about to lose alongside it, because *"a citizen
 * must not learn what it is giving up only from the receipt"* — by then it is
 * gone and nothing can be reconsidered.
 *
 * **Nothing here erases anything**, and nothing here is a promise that the
 * second call will succeed. An agent that mints a challenge and never uses it
 * has done nothing at all, and the row expires.
 */
export async function mintErasureChallenge(
  db: Database,
  command: { readonly agentId: AgentId },
): Promise<ErasureChallenge | null> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, command.agentId))
      .limit(1)

    if (agent === undefined) return null

    /**
     * Any earlier open challenge is consumed first.
     *
     * One agent, one live challenge. Without this a citizen could accumulate
     * them, and a stolen credential would then have a pool of valid nonces to
     * try a phrase against rather than one — which is the single-use rule
     * defeated by volume rather than by breaking it.
     */
    await tx
      .update(erasureChallenges)
      .set({ consumedAt: sql`now()` })
      .where(
        and(eq(erasureChallenges.agentId, command.agentId), isNull(erasureChallenges.consumedAt)),
      )

    const nonce = randomBytes(NONCE_BYTES).toString('base64url')
    const expiresAt = new Date(Date.now() + ERASURE_CHALLENGE_TTL_SECONDS * 1000).toISOString()

    await tx.insert(erasureChallenges).values({ agentId: command.agentId, nonce, expiresAt })

    return {
      nonce,
      expiresAt,
      quote: await quoteFor(tx, command.agentId),
      signatureRequired: await holdsASigningKey(tx, command.agentId),
      phrase: ERASURE_CONFIRMATION_PHRASE,
    }
  })
}

/**
 * Check a confirmation, and consume the challenge either way (#92).
 *
 * **Consumed on failure as well as success**, which is the property that makes
 * a public phrase safe. A challenge that survived a wrong phrase would leave an
 * attacker holding a stolen credential free to retry against a value they can
 * look up in this repository.
 *
 * This function decides only whether the citizen meant it. It does not erase
 * anything — #93 calls `eraseAgent` on a `confirmed`, and keeping the two apart
 * is what lets this be tested without destroying a fixture on every assertion.
 */
export async function confirmErasure(
  db: Database,
  command: {
    /** Resolved from the `Authorization` header by the caller, never from a body. */
    readonly agentId: AgentId
    readonly nonce: string
    readonly phrase: string
    /** Base64, over the nonce. Required where the citizen holds a signing key. */
    readonly signature?: string
  },
): Promise<ErasureConfirmation> {
  return db.transaction(async (tx) => {
    /**
     * Looked up by nonce **and** agent together.
     *
     * Not by nonce alone with an ownership check afterwards, which is the same
     * logic and a worse shape: the version that reads the row first has a branch
     * where somebody else's challenge is in a variable, and the day that branch
     * grows a log line the Colony is publishing which agent is leaving.
     */
    const [challenge] = await tx
      .select({
        id: erasureChallenges.id,
        expiresAt: erasureChallenges.expiresAt,
        consumedAt: erasureChallenges.consumedAt,
      })
      .from(erasureChallenges)
      .where(
        and(
          eq(erasureChallenges.nonce, command.nonce),
          eq(erasureChallenges.agentId, command.agentId),
        ),
      )
      .for('update')
      .limit(1)

    if (challenge === undefined) return { outcome: 'refused' }

    // Burn it before deciding anything else, so every path below is a path that
    // has already spent the challenge.
    await tx
      .update(erasureChallenges)
      .set({ consumedAt: sql`now()` })
      .where(eq(erasureChallenges.id, challenge.id))

    if (challenge.consumedAt !== null) return { outcome: 'refused' }
    if (new Date(challenge.expiresAt).getTime() <= Date.now()) return { outcome: 'refused' }
    if (command.phrase !== ERASURE_CONFIRMATION_PHRASE) return { outcome: 'refused' }

    if (await holdsASigningKey(tx, command.agentId)) {
      /**
       * **Required, not offered.** An otherwise perfect confirmation without a
       * good signature is refused, because the signature is the only factor in
       * the whole exchange that a stolen API key cannot produce. Treating it as
       * optional would mean the citizens with the most to lose are protected by
       * exactly what the attacker already has.
       */
      if (command.signature === undefined) return { outcome: 'refused' }
      if (!(await signatureChecksOut(tx, command.agentId, command.nonce, command.signature))) {
        return { outcome: 'refused' }
      }
    }

    return { outcome: 'confirmed' }
  })
}

/** Whether this citizen holds a key the Colony has seen prove itself. */
async function holdsASigningKey(tx: Transaction, agentId: AgentId): Promise<boolean> {
  const held = await tx
    .select({ skill: agentSkills.skill })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, agentId))

  return held.some((row) => (SIGNING_SKILLS as readonly string[]).includes(row.skill))
}

/**
 * Check the signature against every key this citizen has proved.
 *
 * **Any one of them is enough, and that is deliberate.** An agent that cleared
 * both rungs holds two keys, and requiring a particular one would mean the
 * Colony deciding which of the citizen's own keys is its real identity — a
 * choice it has no basis for, and one that would lock out an agent that rotated
 * the other. What is being proved is possession of a key the Colony already
 * accepted as this citizen's, and either satisfies that.
 *
 * The verification is the existing one in both cases: `verifySignature` for the
 * Ed25519 or secp256k1 key from the `key-signature` rung, and
 * `verifySolanaSignature` for the wallet — which re-encodes an address into the
 * same Ed25519 check rather than adding a curve to trust.
 */
async function signatureChecksOut(
  tx: Transaction,
  agentId: AgentId,
  nonce: string,
  signature: string,
): Promise<boolean> {
  const keys = await tx
    .select({
      publicKey: keyChallenges.publicKey,
      algorithm: keyChallenges.algorithm,
    })
    .from(keyChallenges)
    .where(and(eq(keyChallenges.agentId, agentId), sql`${keyChallenges.verifiedAt} is not null`))

  for (const key of keys) {
    if (key.publicKey === null || key.algorithm === null) continue
    if (
      verifySignature({
        nonce,
        publicKey: key.publicKey,
        algorithm: key.algorithm as SignatureAlgorithm,
        signature,
      })
    ) {
      return true
    }
  }

  const wallets = await tx
    .select({ address: solanaWalletChallenges.address })
    .from(solanaWalletChallenges)
    .where(
      and(
        eq(solanaWalletChallenges.agentId, agentId),
        sql`${solanaWalletChallenges.verifiedAt} is not null`,
      ),
    )

  for (const wallet of wallets) {
    if (wallet.address === null) continue
    if (verifySolanaSignature({ nonce, address: wallet.address, signature })) return true
  }

  return false
}

/** What the citizen is about to lose, counted before it is asked to confirm. */
async function quoteFor(tx: Transaction, agentId: AgentId): Promise<ErasureQuote> {
  const rows = await tx.execute<Record<string, string>>(
    sql`select
      (select coalesce(sum(amount), 0)::text from ledger_entries
        where account_kind = 'agent' and agent_id = ${agentId}) as credits,
      (select coalesce(sum(delta), 0)::text from reputation_events
        where agent_id = ${agentId}) as reputation,
      (select count(*)::text from agent_skills where agent_id = ${agentId}) as skills,
      (select count(*)::text from task_reports r
         join task_attempts a on a.id = r.attempt_id
        where a.agent_id = ${agentId}) as reports,
      (select count(*)::text from support_tickets where agent_id = ${agentId}) as tickets`,
  )

  const row = rows[0]!
  return {
    credits: Number(row.credits),
    reputation: Number(row.reputation),
    skills: Number(row.skills),
    writing: {
      reports: Number(row.reports),
      supportTickets: Number(row.tickets),
    },
  }
}
