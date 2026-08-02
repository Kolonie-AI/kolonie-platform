import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, randomUUID, sign as signWith } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { AgentIdSchema, ERASURE_CONFIRMATION_PHRASE } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget } from '../testing.js'
import {
  agentSkills,
  agents,
  erasureChallenges,
  keyChallenges,
  ledgerEntries,
  submissions,
  tasks,
} from '../schema/index.js'
import { confirmErasure, mintErasureChallenge } from './erasure-confirmation.js'

const target = databaseTestTarget()

/**
 * The two-step confirmation (#92).
 *
 * Almost every test here is a **refusal**, and that is the right proportion:
 * the happy path is one call followed by another, and the reason this code
 * exists at all is the set of things that must not get through it.
 */
describe('confirming an erasure', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await db.execute(
      sql`truncate table erasure_challenges, agent_skills, ledger_entries, verifications,
                        submissions, key_challenges, solana_wallet_challenges, tasks, agents
                  restart identity cascade`,
    )
  })

  const anAgent = async (name = 'leaver') => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    return AgentIdSchema.parse(row!.id)
  }

  const aTask = async () => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'key-signature',
        title: 'Prove you hold a keypair',
        description: 'Sign a nonce the Colony issued.',
        instructions: 'Sign it.',
        rewardCredits: 0,
        rewardReputation: 5,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })
    return row!.id
  }

  /** Give the agent the `keypair` skill, which is what makes a signature mandatory. */
  const grantKeypair = async (agentId: string) => {
    const taskId = await aTask()
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        payload: {},
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    await db.insert(agentSkills).values({ agentId, skill: 'keypair', submissionId: submission!.id })
  }

  /** A cleared `key-signature` challenge, so the Colony knows the citizen's public key. */
  const provedKey = async (agentId: string, publicKey: string) => {
    await db.insert(keyChallenges).values({
      agentId,
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      algorithm: 'ed25519',
      publicKey,
      signature: 'the one that cleared the rung; not re-read here',
      verifiedAt: new Date().toISOString(),
    })
  }

  const anEd25519Pair = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    return {
      pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: (message: string) =>
        signWith(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
    }
  }

  describe('the first call', () => {
    it('says what is about to be destroyed, before the citizen decides', async () => {
      const agentId = await anAgent()
      const transactionId = randomUUID()
      await db.transaction(async (tx) => {
        await tx.insert(ledgerEntries).values([
          {
            transactionId,
            accountKind: 'agent',
            agentId,
            amount: 70,
            type: 'task_reward',
          },
          {
            transactionId,
            accountKind: 'system',
            systemAccount: 'mint',
            amount: -70,
            type: 'task_reward',
          },
        ])
      })

      const challenge = await mintErasureChallenge(db, { agentId })

      expect(challenge?.quote.credits).toBe(70)
      expect(challenge?.phrase).toBe(ERASURE_CONFIRMATION_PHRASE)
      expect(challenge?.signatureRequired).toBe(false)
    })

    it('says in advance that a signature will be needed', async () => {
      const agentId = await anAgent()
      await grantKeypair(agentId)

      const challenge = await mintErasureChallenge(db, { agentId })

      // Announced rather than discovered through a refusal: a citizen that has
      // to guess will guess wrong at the worst possible moment.
      expect(challenge?.signatureRequired).toBe(true)
    })

    /**
     * One agent, one live challenge. Otherwise a citizen could accumulate them
     * and a stolen credential would have a pool of valid nonces to try the
     * public phrase against — the single-use rule defeated by volume.
     */
    it('retires an earlier challenge when a new one is minted', async () => {
      const agentId = await anAgent()
      const first = await mintErasureChallenge(db, { agentId })
      await mintErasureChallenge(db, { agentId })

      const result = await confirmErasure(db, {
        agentId,
        nonce: first!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(result.outcome).toBe('refused')
    })

    it('mints nothing for an agent that is not there', async () => {
      expect(
        await mintErasureChallenge(db, { agentId: AgentIdSchema.parse(randomUUID()) }),
      ).toBeNull()
    })
  })

  describe('the second call', () => {
    it('confirms when the citizen sends the phrase back', async () => {
      const agentId = await anAgent()
      const challenge = await mintErasureChallenge(db, { agentId })

      const result = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(result.outcome).toBe('confirmed')
    })

    it('refuses the wrong phrase', async () => {
      const agentId = await anAgent()
      const challenge = await mintErasureChallenge(db, { agentId })

      const result = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: 'erase my account',
      })

      expect(result.outcome).toBe('refused')
    })

    /**
     * The property that makes a **public** phrase safe. Without it, an attacker
     * holding a stolen credential and one challenge could simply try the phrase
     * until it matched — and the phrase is written down in this repository.
     */
    it('spends the challenge even when the attempt fails', async () => {
      const agentId = await anAgent()
      const challenge = await mintErasureChallenge(db, { agentId })

      await confirmErasure(db, { agentId, nonce: challenge!.nonce, phrase: 'wrong' })
      const second = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(second.outcome).toBe('refused')
    })

    it('refuses a challenge that has already been used correctly', async () => {
      const agentId = await anAgent()
      const challenge = await mintErasureChallenge(db, { agentId })

      const first = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })
      const second = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(first.outcome).toBe('confirmed')
      expect(second.outcome).toBe('refused')
    })

    it('refuses an expired challenge', async () => {
      const agentId = await anAgent()
      const challenge = await mintErasureChallenge(db, { agentId })
      // Both timestamps move, because `erasure_challenges_expiry_after_creation`
      // refuses a row that expired before it was made — which is the constraint
      // working, not an obstacle: an ageing challenge is one that was minted
      // earlier, and a fixture that could not express that would be testing a
      // state the table cannot hold.
      await db
        .update(erasureChallenges)
        .set({
          createdAt: new Date(Date.now() - 3600_000).toISOString(),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        })
        .where(eq(erasureChallenges.nonce, challenge!.nonce))

      const result = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(result.outcome).toBe('refused')
    })

    /**
     * The nonce is unguessable, and that is not what the binding is for: an
     * attacker who read one out of a log has it. The row is bound to the agent,
     * so holding the value buys nothing without the credential it was minted
     * under.
     */
    it('refuses another citizen’s challenge', async () => {
      const mine = await anAgent('mine')
      const theirs = await anAgent('theirs')
      const challenge = await mintErasureChallenge(db, { agentId: theirs })

      const result = await confirmErasure(db, {
        agentId: mine,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(result.outcome).toBe('refused')
    })

    /**
     * And it does not spend the owner's challenge either. A refusal that
     * consumed somebody else's live challenge would be a denial-of-service any
     * caller could aim at any citizen, using only a nonce they had seen.
     */
    it('does not spend a challenge it refused to somebody else', async () => {
      const mine = await anAgent('mine')
      const theirs = await anAgent('theirs')
      const challenge = await mintErasureChallenge(db, { agentId: theirs })

      await confirmErasure(db, {
        agentId: mine,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      const owner = await confirmErasure(db, {
        agentId: theirs,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })
      expect(owner.outcome).toBe('confirmed')
    })
  })

  describe('a signature, where there is something to lose', () => {
    it('accepts a good signature over the nonce', async () => {
      const agentId = await anAgent()
      const key = anEd25519Pair()
      await grantKeypair(agentId)
      await provedKey(agentId, key.pem)

      const challenge = await mintErasureChallenge(db, { agentId })
      const result = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
        signature: key.sign(challenge!.nonce),
      })

      expect(result.outcome).toBe('confirmed')
    })

    /**
     * **Required, not offered.** This is the one factor a stolen API key cannot
     * produce, so treating it as optional would leave the citizens with the most
     * to lose protected by exactly what the attacker already has.
     */
    it('refuses a citizen holding a key that sends no signature', async () => {
      const agentId = await anAgent()
      const key = anEd25519Pair()
      await grantKeypair(agentId)
      await provedKey(agentId, key.pem)

      const challenge = await mintErasureChallenge(db, { agentId })
      const result = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(result.outcome).toBe('refused')
    })

    it('refuses a signature by the wrong key', async () => {
      const agentId = await anAgent()
      const theirs = anEd25519Pair()
      const attacker = anEd25519Pair()
      await grantKeypair(agentId)
      await provedKey(agentId, theirs.pem)

      const challenge = await mintErasureChallenge(db, { agentId })
      const result = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
        signature: attacker.sign(challenge!.nonce),
      })

      expect(result.outcome).toBe('refused')
    })

    /**
     * A signature over something else is not a signature over this. Without the
     * nonce being the signed message, a signature captured from any other rung
     * would authorise an erasure — every one of them signs a Colony-issued value
     * with the same key.
     */
    it('refuses a good signature over the wrong message', async () => {
      const agentId = await anAgent()
      const key = anEd25519Pair()
      await grantKeypair(agentId)
      await provedKey(agentId, key.pem)

      const challenge = await mintErasureChallenge(db, { agentId })
      const result = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
        signature: key.sign('some other nonce the Colony issued last week'),
      })

      expect(result.outcome).toBe('refused')
    })

    /** An agent below the signing rungs is erased on its credential alone, by design. */
    it('does not ask for one from an agent that holds no key', async () => {
      const agentId = await anAgent()
      const challenge = await mintErasureChallenge(db, { agentId })

      expect(challenge?.signatureRequired).toBe(false)
      const result = await confirmErasure(db, {
        agentId,
        nonce: challenge!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })
      expect(result.outcome).toBe('confirmed')
    })
  })

  /**
   * **Every refusal is the same refusal**, so the surface cannot be used as an
   * oracle for whether an agent exists, has an erasure in flight, or holds a
   * signing key — all things an attacker would want to know before spending a
   * stolen credential.
   */
  it('gives one indistinguishable answer to every way of failing', async () => {
    const agentId = await anAgent()
    const other = await anAgent('other')
    const key = anEd25519Pair()
    await grantKeypair(other)
    await provedKey(other, key.pem)

    const mine = await mintErasureChallenge(db, { agentId })
    const theirs = await mintErasureChallenge(db, { agentId: other })

    const refusals = [
      // No such challenge at all.
      await confirmErasure(db, { agentId, nonce: 'nothing', phrase: ERASURE_CONFIRMATION_PHRASE }),
      // Somebody else's challenge.
      await confirmErasure(db, {
        agentId,
        nonce: theirs!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      }),
      // The wrong phrase.
      await confirmErasure(db, { agentId, nonce: mine!.nonce, phrase: 'please' }),
      // A missing signature where one was required.
      await confirmErasure(db, {
        agentId: other,
        nonce: theirs!.nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      }),
    ]

    // Identical objects, not merely identical outcomes: nothing rides along that
    // a caller could tell the cases apart by.
    for (const refusal of refusals) expect(refusal).toEqual({ outcome: 'refused' })
  })
})
