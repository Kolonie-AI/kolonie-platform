import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import {
  DomainPersistenceVerifier,
  PERSISTENCE_INTERVAL_DAYS,
  type DomainGrants,
} from './domain-persistence.js'
import type { DomainChallenges } from './domain-verify.js'
import type { DnsReader, DnsReadResult } from './dns.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')
const NONCE = 'b7e2c0a1f3d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4'
const OLD_NONCE = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const NAME = 'colette.example'

const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'name-holder',
    platform: 'other',
    operator: null,
    pronouns: null,
    bio: null,
    capabilities: ['x'],
    avatarUrl: null,
  },
  status: 'citizen',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
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
  submittedAt: '2026-07-31T10:00:00.000Z',
  verifiedAt: null,
}

const zoneAnswering = (result: DnsReadResult): DnsReader => ({ readTxt: async () => result })
const serving = (...records: string[]): DnsReader => zoneAnswering({ outcome: 'ok', records })

const challenges = (nonces: readonly string[]): DomainChallenges => ({
  openNonces: async () => nonces,
  lastExpiry: async () => null,
})

const granted = (name: string | undefined, grantedAt: string): DomainGrants => ({
  grantOf: async () => (name === undefined ? undefined : { name, grantedAt }),
})

const verify = (
  dns: DnsReader,
  deps: { challenges?: DomainChallenges; grants?: DomainGrants } = {},
) =>
  new DomainPersistenceVerifier({
    dns,
    challenges: deps.challenges ?? challenges([NONCE]),
    grants: deps.grants ?? granted(NAME, daysAgo(PERSISTENCE_INTERVAL_DAYS + 1)),
  }).verify(submission, { agent })

describe('DomainPersistenceVerifier', () => {
  it('passes when a fresh nonce is served under the granted name', async () => {
    const result = await verify(serving(`${NONCE} ${AGENT}`))

    expect(result.status).toBe('pass')
    expect(result.metadata?.['name']).toBe(NAME)
    expect(result.metadata?.['nonce']).toBe(NONCE)
  })

  it('refuses a citizen that holds no domain grant', async () => {
    const result = await verify(serving(`${NONCE} ${AGENT}`), {
      grants: granted(undefined, ''),
    })

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('grant-held')
  })

  it('refuses a submission before the interval has elapsed, and says how long is left', async () => {
    const result = await verify(serving(`${NONCE} ${AGENT}`), {
      grants: granted(NAME, daysAgo(PERSISTENCE_INTERVAL_DAYS - 10)),
    })

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('interval-elapsed')
    expect(result.metadata?.['daysLeft']).toBe(10)
  })

  it('does not read the zone before the interval has elapsed', async () => {
    let reads = 0
    const counting: DnsReader = {
      readTxt: async () => {
        reads += 1
        return { outcome: 'ok', records: [] }
      },
    }

    await verify(counting, { grants: granted(NAME, daysAgo(1)) })

    expect(reads).toBe(0)
  })

  /**
   * The heart of the badge. A record still carrying the value from the granting
   * node proves only that nobody deleted it — a citizen that lost its provider
   * credentials passes that, because the record outlives the control.
   *
   * The old nonce cannot be open after ninety days, so this is what the expiry
   * already guarantees rather than a second rule. It is asserted because that
   * guarantee is the design and a future change to the lifetime would break it
   * silently.
   */
  it('refuses the record that earned the skill, when no fresh nonce is in it', async () => {
    const result = await verify(serving(`${OLD_NONCE} ${AGENT}`))

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('nonce-published')
    expect(result.evidence).toContain('from months ago')
  })

  it('refuses a citizen with no live challenge, and asks for a new one', async () => {
    const result = await verify(serving(`${NONCE} ${AGENT}`), { challenges: challenges([]) })

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('nonce-open')
    expect(result.evidence).toContain('It must be a new nonce')
  })

  /**
   * The case the badge exists to detect, and the message matters as much as the
   * verdict: a citizen whose name lapsed must not read this as losing what it
   * earned. A pass is permanent (D-015) and the badge simply does not apply.
   */
  it('fails when the name no longer answers, and says the skill is untouched', async () => {
    const result = await verify(
      zoneAnswering({ outcome: 'no-record', reason: 'it does not exist (ENOTFOUND).' }),
    )

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('record-resolves')
    expect(result.evidence).toContain('skill is untouched')
  })

  it('pends, not fails, so a ninety-day wait is not lost to a resolver problem', async () => {
    const result = await verify(
      zoneAnswering({ outcome: 'unavailable', reason: 'asking answered ETIMEOUT.' }),
    )

    expect(result.status).toBe('pending')
  })

  it('reads the name from the grant and ignores anything in the payload', async () => {
    let asked: string | undefined
    const watching: DnsReader = {
      readTxt: async (name) => {
        asked = name
        return { outcome: 'ok', records: [`${NONCE} ${AGENT}`] }
      },
    }

    // An agent that lost the name it proved could otherwise hand in a different
    // one it holds today, and the badge would certify the persistence of nothing.
    await new DomainPersistenceVerifier({
      dns: watching,
      challenges: challenges([NONCE]),
      grants: granted(NAME, daysAgo(PERSISTENCE_INTERVAL_DAYS + 1)),
    }).verify({ ...submission, payload: { name: 'somewhere-else.example' } }, { agent })

    expect(asked).toBe(NAME)
  })
})
