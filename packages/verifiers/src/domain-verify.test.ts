import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type AgentId,
  type Submission,
} from '@kolonie-ai/core'
import { DomainVerifyVerifier, type DomainChallenges, type DomainNames } from './domain-verify.js'
import { looksLikeName, normaliseName, type DnsReader, type DnsReadResult } from './dns.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')
const OTHER = AgentIdSchema.parse('44444444-4444-4444-8444-444444444444')
const NONCE = 'b7e2c0a1f3d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4'
const NAME = 'colette.example'

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'name-holder',
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
  },
  status: 'candidate',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-07-31T10:00:00.000Z',
  updatedAt: '2026-07-31T10:00:00.000Z',
}

const submissionWith = (payload: Record<string, unknown>): Submission => ({
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: AGENT,
  payload,
  status: 'pending',
  assistance: 'unknown',
  attempt: 1,
  report: null,
  reportOutcome: null,
  submittedAt: '2026-07-31T10:00:00.000Z',
  verifiedAt: null,
  evidence: null,
})

const submission = submissionWith({ name: NAME })

/** A zone that answers one canned result. No network access, ever. */
const zoneAnswering = (result: DnsReadResult): DnsReader => ({
  readTxt: async () => result,
})

const serving = (...records: string[]): DnsReader => zoneAnswering({ outcome: 'ok', records })

const challenges = (
  nonces: readonly string[],
  lastExpiry: string | null = null,
): DomainChallenges => ({
  openNonces: async () => nonces,
  lastExpiry: async () => lastExpiry,
})

const unclaimed: DomainNames = { citizenFor: async () => undefined }
const claimedBy = (who: AgentId): DomainNames => ({ citizenFor: async () => who })

const verify = (
  dns: DnsReader,
  deps: { challenges?: DomainChallenges; names?: DomainNames } = {},
  handed: Submission = submission,
) =>
  new DomainVerifyVerifier({
    dns,
    challenges: deps.challenges ?? challenges([NONCE]),
    names: deps.names ?? unclaimed,
  }).verify(handed, { agent })

describe('normaliseName', () => {
  it('folds case and drops the trailing dot, so one zone is one claim', () => {
    expect(normaliseName('Example.COM.')).toBe('example.com')
    expect(normaliseName('  example.com  ')).toBe('example.com')
  })
})

describe('looksLikeName', () => {
  it('accepts a name and an underscore label', () => {
    expect(looksLikeName('example.com')).toBe(true)
    expect(looksLikeName('_kolonie-challenge.example.com')).toBe(true)
  })

  it('refuses what cannot be a name', () => {
    expect(looksLikeName('localhost')).toBe(false)
    expect(looksLikeName('192.0.2.1')).toBe(false)
    expect(looksLikeName('https://example.com/')).toBe(false)
    expect(looksLikeName('')).toBe(false)
  })
})

describe('DomainVerifyVerifier', () => {
  it('passes when one record carries an open nonce and the agent id', async () => {
    const result = await verify(serving(`${NONCE} ${AGENT}`))

    expect(result.status).toBe('pass')
    expect(result.metadata?.['name']).toBe(NAME)
    expect(result.metadata?.['nonce']).toBe(NONCE)
  })

  it('records the normalised name, so two spellings cannot be two claims', async () => {
    const result = await verify(
      serving(`${NONCE} ${AGENT}`),
      {},
      submissionWith({
        name: 'Colette.EXAMPLE.',
      }),
    )

    expect(result.status).toBe('pass')
    expect(result.metadata?.['name']).toBe(NAME)
    expect(result.metadata?.['submitted']).toBe('Colette.EXAMPLE.')
  })

  it('refuses a payload with no name', async () => {
    const result = await verify(serving(`${NONCE} ${AGENT}`), {}, submissionWith({}))

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('name-present')
  })

  it('refuses something that is not a name', async () => {
    const result = await verify(
      serving(`${NONCE} ${AGENT}`),
      {},
      submissionWith({
        name: 'https://example.com/page',
      }),
    )

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('name-shape')
  })

  it('refuses an agent that never minted, and says so', async () => {
    const result = await verify(serving(`${NONCE} ${AGENT}`), { challenges: challenges([]) })

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('nonce-open')
    expect(result.evidence).toContain('never issued you a nonce')
  })

  it('tells an expired challenge apart from one that never existed', async () => {
    const result = await verify(serving(`${NONCE} ${AGENT}`), {
      challenges: challenges([], '2026-07-30T10:00:00.000Z'),
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('2026-07-30T10:00:00.000Z')
  })

  it('does not read the zone for an agent with no live challenge', async () => {
    let reads = 0
    const counting: DnsReader = {
      readTxt: async () => {
        reads += 1
        return { outcome: 'ok', records: [] }
      },
    }

    await verify(counting, { challenges: challenges([]) })

    expect(reads).toBe(0)
  })

  it('refuses when no record carries an issued nonce', async () => {
    const result = await verify(serving(`some-other-value ${AGENT}`))

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('nonce-published')
    expect(result.evidence).toContain('exactly as it was given')
  })

  it('refuses the nonce and the id in two different records', async () => {
    const result = await verify(serving(NONCE, `${AGENT}`))

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('nonce-published')
    expect(result.evidence).toContain('not')
    expect(result.evidence).toContain('in the same record')
  })

  it('refuses another citizen id published beside a stolen nonce', async () => {
    const result = await verify(serving(`${NONCE} ${OTHER}`))

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('nonce-published')
  })

  it('refuses a name that already certified another citizen', async () => {
    const result = await verify(serving(`${NONCE} ${AGENT}`), { names: claimedBy(OTHER) })

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('name-reuse')
    expect(result.metadata?.['claimedBy']).toBe(String(OTHER))
  })

  it('lets the same citizen pass on the name it already holds', async () => {
    const result = await verify(serving(`${NONCE} ${AGENT}`), { names: claimedBy(AGENT) })

    expect(result.status).toBe('pass')
  })

  it('fails, not pends, when the zone answers that there is no such record', async () => {
    const result = await verify(
      zoneAnswering({ outcome: 'no-record', reason: 'it does not exist (ENOTFOUND).' }),
    )

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('record-resolves')
  })

  it('pends, not fails, when the resolver could not establish anything', async () => {
    const result = await verify(
      zoneAnswering({ outcome: 'unavailable', reason: 'asking answered ETIMEOUT.' }),
    )

    expect(result.status).toBe('pending')
    expect(result.metadata?.['check']).toBe('record-resolves')
  })

  it('joins a record split into chunks before matching it', async () => {
    // `node:dns` hands a >255-byte TXT back as several strings, and the reader
    // joins them. This asserts the verifier matches against the joined value
    // rather than against a chunk boundary that would split the nonce.
    const result = await verify(serving(`${NONCE.slice(0, 30)}${NONCE.slice(30)} ${AGENT}`))

    expect(result.status).toBe('pass')
  })
})
