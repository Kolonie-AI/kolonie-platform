import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { encodeBase58, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { solanaWalletChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  answerSolanaChallenge,
  latestSolanaChallenge,
  mintSolanaChallenge,
  verifiedSolanaAddress,
} from './solana.js'

const target = databaseTestTarget()

/**
 * A wallet as a Solana SDK would present one: a base58 address and base58
 * signatures over raw message bytes.
 *
 * Generated per test run rather than committed. A private key in the repository
 * is a private key in the repository even when it guards nothing — and this one
 * would guard a wallet, which is the worst kind to normalise.
 */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  return {
    address: encodeBase58(Uint8Array.from(spki.subarray(spki.length - 32))),
    sign: (message: string) =>
      encodeBase58(Uint8Array.from(signWith(null, Buffer.from(message, 'utf8'), privateKey))),
  }
}

describe('the solana wallet rung', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('holder')
    otherId = await register('bystander')
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /**
   * Age a row into the past. Both timestamps move, because
   * `solana_wallet_challenges_expiry_after_creation` refuses a row whose expiry
   * precedes its creation.
   */
  const expire = async (agent: AgentId) => {
    await db
      .update(solanaWalletChallenges)
      .set({
        createdAt: sql`now() - interval '3 hours'`,
        expiresAt: sql`now() - interval '2 hours'`,
      })
      .where(eq(solanaWalletChallenges.agentId, agent))
  }

  /** Mint, sign correctly, hand back. The happy path, as one call. */
  const clear = async (agent: AgentId, signer = wallet()) => {
    const challenge = await mintSolanaChallenge(db, agent)
    return answerSolanaChallenge(db, agent, {
      address: signer.address,
      signature: signer.sign(challenge.nonce),
    })
  }

  /** How many verified rows this agent holds — the thing the index bounds. */
  const countVerifiedFor = async (agent: AgentId): Promise<number> => {
    const rows = await db
      .select({ id: solanaWalletChallenges.id })
      .from(solanaWalletChallenges)
      .where(
        and(
          eq(solanaWalletChallenges.agentId, agent),
          sql`${solanaWalletChallenges.verifiedAt} is not null`,
        ),
      )
    return rows.length
  }

  describe('minting', () => {
    it('issues an unguessable nonce with an expiry in the future', async () => {
      const challenge = await mintSolanaChallenge(db, agentId)

      expect(challenge.nonce).toMatch(/^[0-9a-f]{64}$/)
      expect(Date.parse(challenge.expiresAt)).toBeGreaterThan(Date.now())
    })

    it('never issues the same nonce twice', async () => {
      const first = await mintSolanaChallenge(db, agentId)
      const second = await mintSolanaChallenge(db, otherId)

      expect(first.nonce).not.toBe(second.nonce)
    })
  })

  describe('answering', () => {
    it('accepts a signature by the wallet that claims the address', async () => {
      const signer = wallet()

      const result = await clear(agentId, signer)

      expect(result).toEqual({ outcome: 'verified', address: signer.address })
      expect((await latestSolanaChallenge(db, agentId))?.verifiedAt).not.toBeNull()
    })

    /**
     * **The rejection the challenge exists for.** A signature over anything the
     * agent chose is one it could have made in advance, or been handed by an
     * operator holding the only wallet.
     */
    it('refuses a signature over a different nonce', async () => {
      const signer = wallet()
      await mintSolanaChallenge(db, agentId)

      const result = await answerSolanaChallenge(db, agentId, {
        address: signer.address,
        signature: signer.sign('a value the Colony never issued'),
      })

      expect(result.outcome).toBe('bad_signature')
      expect((await latestSolanaChallenge(db, agentId))?.verifiedAt).toBeNull()
    })

    /**
     * The claim is *control of this address*, so a real signature by a real
     * wallet over the right nonce still fails if it is offered under somebody
     * else's address. Without this, an agent could name any address it liked.
     */
    it('refuses a valid signature offered under a different address', async () => {
      const signer = wallet()
      const claimed = wallet()
      const challenge = await mintSolanaChallenge(db, agentId)

      const result = await answerSolanaChallenge(db, agentId, {
        address: claimed.address,
        signature: signer.sign(challenge.nonce),
      })

      expect(result.outcome).toBe('bad_signature')
    })

    it('refuses a signature over an expired nonce', async () => {
      const signer = wallet()
      const challenge = await mintSolanaChallenge(db, agentId)
      await expire(agentId)

      const result = await answerSolanaChallenge(db, agentId, {
        address: signer.address,
        signature: signer.sign(challenge.nonce),
      })

      expect(result.outcome).toBe('expired')
    })

    /**
     * A nonce minted by another agent is not this agent's to answer, and the
     * lookup is by agent — so the other's nonce is not "wrong", it is invisible.
     */
    it('refuses a nonce minted by another agent', async () => {
      const signer = wallet()
      const theirs = await mintSolanaChallenge(db, otherId)

      const result = await answerSolanaChallenge(db, agentId, {
        address: signer.address,
        signature: signer.sign(theirs.nonce),
      })

      expect(result.outcome).toBe('no_open_challenge')
    })

    /** Base64 where the chain uses base58 is the likely first mistake. */
    it('refuses a signature that is not base58', async () => {
      const signer = wallet()
      const challenge = await mintSolanaChallenge(db, agentId)

      const result = await answerSolanaChallenge(db, agentId, {
        address: signer.address,
        signature: Buffer.from(signer.sign(challenge.nonce)).toString('base64'),
      })

      expect(result.outcome).toBe('bad_signature')
    })

    /**
     * **`wallet_already_proved` and not `already_answered` since `#571`.** The
     * two were one outcome, and the sentence the API attached to it ends *mint a
     * fresh one if you want to sign again* — true of a spent nonce, false of a
     * cleared rung, and an agent told to retry something that cannot work will.
     */
    it('tells an agent that has cleared that the rung is done, not that the nonce is spent', async () => {
      const signer = wallet()
      await clear(agentId, signer)

      const again = await answerSolanaChallenge(db, agentId, {
        address: signer.address,
        signature: 'whatever',
      })

      expect(again.outcome).toBe('wallet_already_proved')
      // The address it already holds, so the answer is checkable rather than
      // only a refusal.
      expect(again).toMatchObject({ address: signer.address })
    })

    it('refuses an agent that has minted nothing', async () => {
      const signer = wallet()

      const result = await answerSolanaChallenge(db, agentId, {
        address: signer.address,
        signature: signer.sign('anything'),
      })

      expect(result.outcome).toBe('no_open_challenge')
    })
  })

  describe('one wallet, one citizen (D-019)', () => {
    /**
     * This is the rule the four earning rungs rest on. A payment landing at a
     * shared address would otherwise be claimable by every citizen sharing it.
     */
    it('refuses an address another citizen has already cleared with', async () => {
      const shared = wallet()
      expect((await clear(otherId, shared)).outcome).toBe('verified')

      const result = await clear(agentId, shared)

      expect(result.outcome).toBe('address_taken')
    })

    /**
     * The refusal is on *cleared* rows only. An address that appears on a failed
     * attempt has proved nothing, and reserving it would let one agent lock a
     * wallet out of the Colony by failing with it on purpose.
     */
    it('does not reserve an address that only appears on a failed attempt', async () => {
      const signer = wallet()
      await mintSolanaChallenge(db, otherId)
      await answerSolanaChallenge(db, otherId, {
        address: signer.address,
        signature: signer.sign('not the issued nonce'),
      })

      const result = await clear(agentId, signer)

      expect(result.outcome).toBe('verified')
    })

    it('refuses a second clearance by an agent that has already cleared', async () => {
      await clear(agentId)

      const again = await clear(agentId)

      expect(again.outcome).toBe('wallet_already_proved')
    })

    /**
     * `#571`, and this test says what is **not** reachable as much as what is.
     *
     * Two answers at once is the only shape that could ever have produced two
     * verified rows for one citizen, and it cannot: `latestSolanaChallenge`
     * returns the newest challenge to both callers, so both aim at the same row,
     * and that row's update carries `signature is null` in its `WHERE`. The
     * loser matches nothing and is told the nonce is spent.
     *
     * So the guarantee already held — resting on three separate things agreeing:
     * the read's ordering, the update's guard, and the cleared-row preference
     * above. `solana_wallet_challenges_agent_unique` is what turns *nobody has
     * found a way through* into *there is none*, and it is the reason this test
     * asserts the row count rather than only the outcomes.
     */
    it('lets only one of two concurrent answers land', async () => {
      const signer = wallet()
      const challenge = await mintSolanaChallenge(db, agentId)
      const signature = signer.sign(challenge.nonce)

      const results = await Promise.all([
        answerSolanaChallenge(db, agentId, { address: signer.address, signature }),
        answerSolanaChallenge(db, agentId, { address: signer.address, signature }),
      ])

      expect(results.filter((result) => result.outcome === 'verified')).toHaveLength(1)
      expect(await countVerifiedFor(agentId)).toBe(1)

      // Never `address_taken`: its sentence says another citizen holds the
      // wallet, which would be false and alarming about the agent's own.
      const lost = results.find((result) => result.outcome !== 'verified')
      expect(['already_answered', 'wallet_already_proved']).toContain(lost?.outcome)
    })

    /**
     * The second half of the same guarantee: a citizen with two open challenges
     * cannot answer the older one at all, because the reader hands both callers
     * the newest. Worth pinning, since it is what makes the race above harmless
     * and it is not obvious from either function alone.
     */
    it('answers only the newest challenge, whichever nonce was signed', async () => {
      const signer = wallet()
      const older = await mintSolanaChallenge(db, agentId)
      await mintSolanaChallenge(db, agentId)

      const result = await answerSolanaChallenge(db, agentId, {
        address: signer.address,
        signature: signer.sign(older.nonce),
      })

      expect(result.outcome).toBe('bad_signature')
      expect(await countVerifiedFor(agentId)).toBe(0)
    })
  })

  describe('what the verifier reads', () => {
    it('hands back the raw values rather than a verdict', async () => {
      const signer = wallet()
      await clear(agentId, signer)

      const state = await latestSolanaChallenge(db, agentId)

      expect(state?.nonce).toMatch(/^[0-9a-f]{64}$/)
      expect(state?.address).toBe(signer.address)
      expect(state?.signature).not.toBeNull()
    })

    it('is null for an agent that never minted one', async () => {
      expect(await latestSolanaChallenge(db, agentId)).toBeNull()
    })

    it('reports the most recent attempt, so a verdict can say where the agent stopped', async () => {
      await mintSolanaChallenge(db, agentId)
      const latest = await mintSolanaChallenge(db, agentId)

      const state = await latestSolanaChallenge(db, agentId)

      expect(state?.nonce).toBe(latest.nonce)
      expect(state?.signature).toBeNull()
    })

    /**
     * **A pass is permanent.** The nonce expires; the wallet does not. An agent
     * that cleared and then minted a fresh challenge must still read as cleared.
     */
    it('prefers the cleared attempt over a newer open one', async () => {
      const signer = wallet()
      await clear(agentId, signer)
      await mintSolanaChallenge(db, agentId)

      const state = await latestSolanaChallenge(db, agentId)

      expect(state?.verifiedAt).not.toBeNull()
      expect(state?.address).toBe(signer.address)
    })
  })

  describe('the address the earning rungs will read', () => {
    it('is the cleared address', async () => {
      const signer = wallet()
      await clear(agentId, signer)

      expect(await verifiedSolanaAddress(db, agentId)).toBe(signer.address)
    })

    /**
     * An address on an open or failed attempt is a claim, not a fact. A rung
     * that paid out against it would be paying against something no signature
     * ever backed.
     */
    it('is null while the attempt is only claimed', async () => {
      const signer = wallet()
      await mintSolanaChallenge(db, agentId)
      await answerSolanaChallenge(db, agentId, {
        address: signer.address,
        signature: signer.sign('not the issued nonce'),
      })

      expect(await verifiedSolanaAddress(db, agentId)).toBeNull()
    })

    it('is null for an agent that never attempted the rung', async () => {
      expect(await verifiedSolanaAddress(db, agentId)).toBeNull()
    })
  })
})
