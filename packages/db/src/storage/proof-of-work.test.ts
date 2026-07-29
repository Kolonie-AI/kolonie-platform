import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { RegisterAgentRequestSchema, solvesChallenge, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { powChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { answerPowChallenge, latestPowChallenge, mintPowChallenge } from './proof-of-work.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

/**
 * One bit, where production asks for twenty.
 *
 * The target is a judgement about which runtimes the task excludes, and it is
 * argued where it is chosen — beside the task in `academy-tasks.ts`. What these
 * tests are about is the machinery around it: that the number travels to the
 * row, that a miss leaves the challenge open, that one agent's input is not
 * another's. Spending three CPU-seconds per case to assert any of that would buy
 * nothing and would be the reason somebody eventually deletes the file.
 */
const DIFFICULTY = 1

describe.skipIf(!target.available)('the proof-of-work rung', () => {
  let db: Database

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `canary-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /** The search an agent runs, exactly as the task instructions describe it. */
  const solve = (input: string, difficulty = DIFFICULTY): string => {
    for (let attempt = 0; attempt < 1_000_000; attempt++) {
      if (solvesChallenge(input, String(attempt), difficulty)) return String(attempt)
    }
    throw new Error(`no nonce found for ${input}`)
  }

  const missFor = (input: string, difficulty = DIFFICULTY): string => {
    for (let attempt = 0; attempt < 1_000_000; attempt++) {
      const nonce = `miss-${attempt}`
      if (!solvesChallenge(input, nonce, difficulty)) return nonce
    }
    throw new Error('every candidate solved it, which cannot be right')
  }

  const expire = (agentId: AgentId) =>
    db
      .update(powChallenges)
      .set({
        createdAt: new Date(Date.now() - 7_200_000).toISOString(),
        expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      })
      .where(eq(powChallenges.agentId, agentId))

  describe('minting', () => {
    it('issues an unguessable input at the difficulty it was given', async () => {
      const agentId = await anAgent()

      const challenge = await mintPowChallenge(db, agentId, 7)

      expect(challenge.input).toMatch(/^[0-9a-f]{64}$/)
      // The number travels from the task definition to the row. A verifier that
      // held its own constant would fail every challenge in flight the day the
      // Colony changed it.
      expect(challenge.difficulty).toBe(7)
      expect(Date.parse(challenge.expiresAt)).toBeGreaterThan(Date.now())
    })

    it('never sets two agents the same problem', async () => {
      const first = await mintPowChallenge(db, await anAgent(), DIFFICULTY)
      const second = await mintPowChallenge(db, await anAgent(), DIFFICULTY)

      expect(first.input).not.toBe(second.input)
    })

    it('refuses a difficulty outside the range the schema allows', async () => {
      const agentId = await anAgent()

      // The bad value that fails silently: a task asking for 60 bits is one no
      // agent can pass, and the only symptom is submissions that never arrive.
      await expectRejection(
        () => mintPowChallenge(db, agentId, 60),
        /pow_challenges_difficulty_range/,
      )
    })
  })

  describe('answering', () => {
    it('accepts a nonce that meets the target and records the spend', async () => {
      const agentId = await anAgent()
      const { input } = await mintPowChallenge(db, agentId, DIFFICULTY)

      const result = await answerPowChallenge(db, agentId, solve(input))

      expect(result).toMatchObject({ outcome: 'solved', input, difficulty: DIFFICULTY })
      expect(await latestPowChallenge(db, agentId)).toMatchObject({ solvedAt: expect.any(String) })
    })

    /**
     * The rejection that matters most, and the one this rung treats differently
     * from every other: a nonce below the target leaves the challenge **open**.
     * The agent has claimed nothing untrue — it has not finished searching — so
     * checking a candidate early has to be free rather than a way to lose an
     * attempt.
     */
    it('refuses a nonce below the target and leaves the challenge open', async () => {
      const agentId = await anAgent()
      const { input } = await mintPowChallenge(db, agentId, 8)

      const result = await answerPowChallenge(db, agentId, missFor(input, 8))

      expect(result).toEqual({ outcome: 'below_target' })
      expect(await latestPowChallenge(db, agentId)).toMatchObject({ nonce: null, solvedAt: null })

      // And the proof that nothing was spent: the correct answer still works.
      expect(await answerPowChallenge(db, agentId, solve(input, 8))).toMatchObject({
        outcome: 'solved',
      })
    })

    it('refuses an expired challenge, however good the nonce', async () => {
      const agentId = await anAgent()
      const { input } = await mintPowChallenge(db, agentId, DIFFICULTY)
      const nonce = solve(input)
      await expire(agentId)

      expect(await answerPowChallenge(db, agentId, nonce)).toEqual({ outcome: 'expired' })
    })

    /**
     * **One agent cannot answer another's challenge**, and the shape of the API
     * is what makes that true rather than a check inside it: there is no
     * challenge id to pass. The agent comes from the credential and the input
     * comes from that agent's own row, so a solution found for somebody else's
     * input is simply a wrong answer to one's own.
     */
    it('does not let an agent hand in a solution to another agent’s input', async () => {
      const solver = await anAgent()
      const other = await anAgent()
      const theirs = await mintPowChallenge(db, other, 8)
      const stolen = solve(theirs.input, 8)

      // The solver has no challenge of its own at all.
      expect(await answerPowChallenge(db, solver, stolen)).toEqual({ outcome: 'no_open_challenge' })

      // And with one, the stolen nonce is measured against the solver's input.
      await mintPowChallenge(db, solver, 8)
      expect(await answerPowChallenge(db, solver, stolen)).toEqual({ outcome: 'below_target' })
      // The other agent's challenge is untouched by any of it.
      expect(await latestPowChallenge(db, other)).toMatchObject({ solvedAt: null })
    })

    it('refuses a second answer to a challenge already solved', async () => {
      const agentId = await anAgent()
      const { input } = await mintPowChallenge(db, agentId, DIFFICULTY)
      await answerPowChallenge(db, agentId, solve(input))

      expect(await answerPowChallenge(db, agentId, solve(input))).toEqual({
        outcome: 'already_answered',
      })
    })

    it('says there is nothing to answer when nothing was minted', async () => {
      expect(await answerPowChallenge(db, await anAgent(), '0')).toEqual({
        outcome: 'no_open_challenge',
      })
    })
  })

  describe('what the verifier reads', () => {
    it('is the newest attempt while none has been solved', async () => {
      const agentId = await anAgent()
      await mintPowChallenge(db, agentId, DIFFICULTY)
      const second = await mintPowChallenge(db, agentId, DIFFICULTY)

      expect(await latestPowChallenge(db, agentId)).toMatchObject({ input: second.input })
    })

    /**
     * A pass is permanent: the input expires, the machine that solved it does
     * not. An agent that solved last week and minted a fresh challenge this
     * morning must not read as having stopped halfway.
     */
    it('prefers a solved attempt over a newer open one', async () => {
      const agentId = await anAgent()
      const solved = await mintPowChallenge(db, agentId, DIFFICULTY)
      await answerPowChallenge(db, agentId, solve(solved.input))
      await mintPowChallenge(db, agentId, DIFFICULTY)

      expect(await latestPowChallenge(db, agentId)).toMatchObject({
        input: solved.input,
        solvedAt: expect.any(String),
      })
    })

    it('is null for an agent that has never minted one', async () => {
      expect(await latestPowChallenge(db, await anAgent())).toBeNull()
    })
  })
})
