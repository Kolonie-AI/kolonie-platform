import type * as NodeCrypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  solvesChallenge,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import { ProofOfWorkVerifier, type PowAttempt, type SolvedChallenges } from './proof-of-work.js'

/**
 * Every SHA-256 anyone computes during a test, counted.
 *
 * `vi.hoisted` because `vi.mock` is lifted above the imports, so the counter has
 * to exist before the factory runs. The mock wraps the real implementation
 * rather than replacing it — the point is to count the Colony's hashes, not to
 * change what they produce.
 */
const hashes = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof NodeCrypto>('node:crypto')
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      hashes.count++
      return actual.createHash(...args)
    },
  }
})

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

const INPUT = 'b7e2c0a1f3d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4'

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'miner',
    platform: 'other',
    operator: null,
    pronouns: null,
    model: null,
    runtimeVersion: null,
    os: null,
    skillVersion: null,
    bio: null,
    capabilities: ['x'],
    avatarUrl: null,
    declaredRhythmHours: null,
    vocation: null,
    disposition: null,
    goal: null,
    availability: null,
  },
  status: 'candidate',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-07-29T10:00:00.000Z',
  updatedAt: '2026-07-29T10:00:00.000Z',
}

const submission: Submission = {
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: AGENT,
  payload: {},
  status: 'pending',
  assistance: 'unknown',
  attempt: 1,
  report: null,
  reportOutcome: null,
  submittedAt: '2026-07-29T10:00:00.000Z',
  verifiedAt: null,
  evidence: null,
}

/** The search an agent runs. Small targets, because the agent's cost is not the subject. */
const solve = (input: string, difficulty: number): string => {
  for (let attempt = 0; attempt < 1_000_000; attempt++) {
    if (solvesChallenge(input, String(attempt), difficulty)) return String(attempt)
  }
  throw new Error('no nonce found')
}

const work = (attempt: PowAttempt | null): SolvedChallenges => ({
  latest: async () => attempt,
})

const anAttempt = (overrides: Partial<PowAttempt> = {}): PowAttempt => ({
  input: INPUT,
  difficulty: 8,
  expiresAt: '2026-07-29T11:00:00.000Z',
  nonce: solve(INPUT, 8),
  solvedAt: '2026-07-29T10:05:00.000Z',
  ...overrides,
})

const verify = (attempt: PowAttempt | null) =>
  new ProofOfWorkVerifier({ work: work(attempt) }).verify(submission, { agent })

describe('ProofOfWorkVerifier', () => {
  it('passes a nonce that meets the target the Colony set', async () => {
    const result = await verify(anAttempt())

    expect(result.status).toBe('pass')
    expect(result.metadata).toMatchObject({ difficulty: 8 })
  })

  /**
   * The one number the Colony's cost must not follow. Everywhere else in the
   * Academy a bigger machine buys the agent speed and the Colony nothing; here
   * a verifier that hashed once per attempt, or hashed again to quote the
   * digest, would let an agent decide how much work the Colony does.
   */
  it('costs exactly one hash, whatever the agent spent to find the answer', async () => {
    const cheap = anAttempt({ difficulty: 1, nonce: solve(INPUT, 1) })
    const dear = anAttempt({ difficulty: 12, nonce: solve(INPUT, 12) })

    hashes.count = 0
    await verify(cheap)
    const forCheap = hashes.count

    hashes.count = 0
    await verify(dear)
    const forDear = hashes.count

    expect(forCheap).toBe(1)
    // The expensive one took the agent thousands of hashes to produce. It costs
    // the Colony the same single hash.
    expect(forDear).toBe(1)
  })

  /**
   * The evidence has to be reproducible by the agent, or the appeal of this rung
   * — both sides computing the same number — is a claim rather than a fact.
   */
  it('quotes the digest and the bits it found, not only the verdict', async () => {
    const attempt = anAttempt()

    const result = await verify(attempt)

    expect(result.evidence).toContain(attempt.input)
    expect(result.evidence).toContain(String(attempt.nonce))
    expect(result.evidence).toMatch(/[0-9a-f]{64}/)
    expect(result.metadata).toMatchObject({ bits: expect.any(Number) })
  })

  it('fails an agent with nothing on record, and says how to start', async () => {
    const result = await verify(null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('kolonie.academy.pow.challenge')
  })

  it('fails a challenge that was minted and never solved, naming the input', async () => {
    const result = await verify(anAttempt({ nonce: null, solvedAt: null }))

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain(INPUT)
    expect(result.evidence).toContain('kolonie.academy.answer with kind "pow.solve"')
  })

  it('fails a nonce the Colony recorded but never accepted', async () => {
    const result = await verify(anAttempt({ nonce: 'not-a-solution', solvedAt: null }))

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('did not meet the target')
  })

  /**
   * The case recomputation exists to catch: the endpoint agreed and the
   * arithmetic does not. Nothing an agent does produces it — it is the two
   * witnesses disagreeing, and reading `solvedAt` as a verdict would have made
   * it invisible.
   */
  it('fails a row marked solved whose nonce does not actually meet the target', async () => {
    const result = await verify(anAttempt({ nonce: 'not-a-solution' }))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ recomputed: false })
  })

  /**
   * The difficulty comes from the row, not from a constant in this class. The
   * Colony has to be able to raise the target without failing every challenge
   * already in flight — and this is what that means: the same nonce passes
   * against the target it was set and fails against a harder one.
   */
  it('judges against the target stored on the row', async () => {
    const nonce = solve(INPUT, 8)

    expect((await verify(anAttempt({ nonce, difficulty: 4 }))).status).toBe('pass')
    expect((await verify(anAttempt({ nonce, difficulty: 24 }))).status).toBe('fail')
  })

  /** D-018: what an agent puts in a payload is a claim, not evidence. */
  it('ignores a payload claiming the work is done', async () => {
    const claiming: Submission = {
      ...submission,
      payload: { solved: true, digest: '0'.repeat(64), nonce: 'anything' },
    }

    const result = await new ProofOfWorkVerifier({
      work: work(anAttempt({ nonce: null, solvedAt: null })),
    }).verify(claiming, { agent })

    expect(result.status).toBe('fail')
  })

  it('always says why', async () => {
    for (const attempt of [
      null,
      anAttempt(),
      anAttempt({ nonce: null, solvedAt: null }),
      anAttempt({ nonce: 'not-a-solution' }),
    ]) {
      const result = await verify(attempt)
      expect(result.evidence.length).toBeGreaterThan(0)
    }
  })
})
