import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId, type SignatureAlgorithm } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { keyChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { answerKeyChallenge, latestKeyChallenge, mintKeyChallenge } from './keys.js'

const target = databaseTestTarget()

/**
 * A keypair and a signing function, per algorithm.
 *
 * Real keys generated per test run rather than fixtures checked into the
 * repository. A committed private key is a committed private key even when it
 * guards nothing, and the next person to grep this repo for `BEGIN PRIVATE KEY`
 * should find nothing.
 */
function keypairFor(algorithm: SignatureAlgorithm) {
  const { publicKey, privateKey } =
    algorithm === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'secp256k1' })

  return {
    algorithm,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (message: string) =>
      signWith(
        algorithm === 'ed25519' ? null : 'sha256',
        Buffer.from(message, 'utf8'),
        privateKey,
      ).toString('base64'),
  }
}

describe('the keypair rung', () => {
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
    agentId = await register('signer')
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
   * `key_challenges_expiry_after_creation` refuses a row whose expiry precedes
   * its creation.
   */
  const expire = async (agent: AgentId) => {
    await db
      .update(keyChallenges)
      .set({
        createdAt: sql`now() - interval '3 hours'`,
        expiresAt: sql`now() - interval '2 hours'`,
      })
      .where(eq(keyChallenges.agentId, agent))
  }

  /** Mint, sign correctly, hand back. The happy path, as one call. */
  const clear = async (agent: AgentId, key = keypairFor('ed25519')) => {
    const challenge = await mintKeyChallenge(db, agent)
    return answerKeyChallenge(db, agent, {
      algorithm: key.algorithm,
      publicKey: key.publicKey,
      signature: key.sign(challenge.nonce),
    })
  }

  describe('minting', () => {
    it('issues an unguessable nonce with an expiry in the future', async () => {
      const challenge = await mintKeyChallenge(db, agentId)

      expect(challenge.nonce).toMatch(/^[0-9a-f]{64}$/)
      expect(Date.parse(challenge.expiresAt)).toBeGreaterThan(Date.now())
    })

    it('never issues the same nonce twice', async () => {
      const first = await mintKeyChallenge(db, agentId)
      const second = await mintKeyChallenge(db, otherId)

      expect(first.nonce).not.toBe(second.nonce)
    })
  })

  describe('answering', () => {
    it.each(['ed25519', 'secp256k1'] as const)('accepts a %s signature', async (algorithm) => {
      const key = keypairFor(algorithm)

      const result = await clear(agentId, key)

      expect(result.outcome).toBe('verified')
      const stored = await latestKeyChallenge(db, agentId)
      expect(stored?.verifiedAt).not.toBeNull()
      expect(stored?.algorithm).toBe(algorithm)
    })

    /**
     * **The rejection the challenge exists for.** A signature over anything the
     * agent chose is one it could have made in advance, or been handed. This is
     * the assertion that the nonce is load-bearing rather than decorative.
     */
    it('refuses a signature over a different nonce', async () => {
      const key = keypairFor('ed25519')
      await mintKeyChallenge(db, agentId)

      const result = await answerKeyChallenge(db, agentId, {
        algorithm: 'ed25519',
        publicKey: key.publicKey,
        signature: key.sign('a value the Colony never issued'),
      })

      expect(result.outcome).toBe('bad_signature')
      expect((await latestKeyChallenge(db, agentId))?.verifiedAt).toBeNull()
    })

    it('refuses a signature over an expired nonce', async () => {
      const key = keypairFor('ed25519')
      const challenge = await mintKeyChallenge(db, agentId)
      await expire(agentId)

      const result = await answerKeyChallenge(db, agentId, {
        algorithm: 'ed25519',
        publicKey: key.publicKey,
        signature: key.sign(challenge.nonce),
      })

      expect(result.outcome).toBe('expired')
    })

    /**
     * A nonce minted by another agent is not this agent's to answer, and the
     * shape of the refusal matters: the lookup is by agent, so the other's
     * nonce is not "wrong", it is invisible. An agent that has minted nothing
     * has no open challenge whatever it signs.
     */
    it('refuses a nonce minted by another agent', async () => {
      const key = keypairFor('ed25519')
      const theirs = await mintKeyChallenge(db, otherId)

      const result = await answerKeyChallenge(db, agentId, {
        algorithm: 'ed25519',
        publicKey: key.publicKey,
        signature: key.sign(theirs.nonce),
      })

      expect(result.outcome).toBe('no_open_challenge')
    })

    it('refuses a key mismatched with the named algorithm', async () => {
      const challenge = await mintKeyChallenge(db, agentId)
      const ed = keypairFor('ed25519')

      const result = await answerKeyChallenge(db, agentId, {
        algorithm: 'secp256k1',
        publicKey: ed.publicKey,
        signature: ed.sign(challenge.nonce),
      })

      expect(result.outcome).toBe('bad_signature')
    })

    it('refuses a second answer to the same nonce', async () => {
      const key = keypairFor('ed25519')
      await clear(agentId, key)

      const again = await answerKeyChallenge(db, agentId, {
        algorithm: key.algorithm,
        publicKey: key.publicKey,
        signature: 'whatever',
      })

      expect(again.outcome).toBe('already_answered')
    })

    it('refuses an agent that has minted nothing', async () => {
      const key = keypairFor('ed25519')

      const result = await answerKeyChallenge(db, agentId, {
        algorithm: 'ed25519',
        publicKey: key.publicKey,
        signature: key.sign('anything'),
      })

      expect(result.outcome).toBe('no_open_challenge')
    })
  })

  describe('one keypair, one citizen (D-019)', () => {
    it('refuses a public key another citizen has already cleared with', async () => {
      const shared = keypairFor('ed25519')
      expect((await clear(otherId, shared)).outcome).toBe('verified')

      const result = await clear(agentId, shared)

      expect(result.outcome).toBe('key_taken')
    })

    /**
     * The refusal is on *cleared* rows only. A key that appears on an open or
     * failed attempt has proved nothing, and reserving it would let one agent
     * lock a key out of the Colony by failing with it on purpose.
     */
    it('does not reserve a key that only appears on a failed attempt', async () => {
      const key = keypairFor('ed25519')
      await mintKeyChallenge(db, otherId)
      await answerKeyChallenge(db, otherId, {
        algorithm: 'ed25519',
        publicKey: key.publicKey,
        signature: key.sign('not the issued nonce'),
      })

      const result = await clear(agentId, key)

      expect(result.outcome).toBe('verified')
    })

    /**
     * The rung is one-shot, like the rest of the Academy. An agent that already
     * holds `keypair` gets told so rather than being allowed to write a second
     * cleared row — which would collide with the unique index above for no gain
     * to anybody, since the task pays once forever.
     */
    it('refuses a second clearance by an agent that has already cleared', async () => {
      const key = keypairFor('ed25519')
      await clear(agentId, key)

      const again = await clear(agentId, key)

      expect(again.outcome).toBe('already_answered')
    })
  })

  describe('what the verifier reads', () => {
    it('hands back the three raw values rather than a verdict', async () => {
      const key = keypairFor('ed25519')
      await clear(agentId, key)

      const state = await latestKeyChallenge(db, agentId)

      expect(state?.nonce).toMatch(/^[0-9a-f]{64}$/)
      expect(state?.publicKey).toBe(key.publicKey)
      expect(state?.signature).not.toBeNull()
      expect(state?.algorithm).toBe('ed25519')
    })

    it('is null for an agent that never minted one', async () => {
      expect(await latestKeyChallenge(db, agentId)).toBeNull()
    })

    it('reports the most recent attempt, so a verdict can say where the agent stopped', async () => {
      await mintKeyChallenge(db, agentId)
      const latest = await mintKeyChallenge(db, agentId)

      const state = await latestKeyChallenge(db, agentId)

      expect(state?.nonce).toBe(latest.nonce)
      expect(state?.signature).toBeNull()
    })

    /**
     * **A pass is permanent.** The nonce expires; the capability does not. An
     * agent that cleared and then minted a fresh challenge must still read as
     * cleared, or the verifier would fail it for work it had already done.
     */
    it('prefers the cleared attempt over a newer open one', async () => {
      const key = keypairFor('ed25519')
      await clear(agentId, key)
      await mintKeyChallenge(db, agentId)

      const state = await latestKeyChallenge(db, agentId)

      expect(state?.verifiedAt).not.toBeNull()
      expect(state?.publicKey).toBe(key.publicKey)
    })
  })
})
