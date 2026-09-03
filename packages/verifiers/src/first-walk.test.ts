import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import { FirstWalkVerifier, type WalkStanding } from './first-walk.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'walker',
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
    declaredRhythmMinutes: null,
    vocation: null,
    disposition: null,
    goal: null,
    availability: null,
    profession: null,
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
  submittedAt: '2026-08-16T10:00:00.000Z',
  verifiedAt: null,
  evidence: null,
}

/** A closed walk with nothing said, so each test adds only what it is about. */
const walk = (fields: Partial<WalkStanding> = {}): WalkStanding => ({
  id: '44444444-4444-4444-8444-444444444444',
  kind: 'mailbox',
  provider: 'example.invalid',
  outcome: 'refused',
  finishedAt: '2026-08-16T09:00:00.000Z',
  firstInTheColony: true,
  did: null,
  broke: null,
  changed: null,
  discarded: null,
  note: null,
  ...fields,
})

const verify = (walks: readonly WalkStanding[], remain = true) =>
  new FirstWalkVerifier({
    standings: {
      closedWalks: async () => walks,
      unwalkedEntriesRemain: async () => remain,
    },
  }).verify(submission, { agent })

describe('FirstWalkVerifier', () => {
  it('passes a refused walk at ground nobody had covered', async () => {
    const result = await verify([walk({ broke: 'The signup form rejected the address.' })])

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('example.invalid')
    expect(result.evidence).toContain('refused')
  })

  /**
   * The rung's central claim, and the one a regression would be quietest about:
   * the three outcomes are worth the same, so they are asserted together rather
   * than one of them being taken as representative.
   */
  it.each(['proved', 'refused', 'abandoned'])('passes a walk that ended %s', async (outcome) => {
    const result = await verify([walk({ outcome, did: 'Opened the signup form and tried.' })])

    expect(result.status).toBe('pass')
  })

  it('refuses a walk at a provider somebody had already walked', async () => {
    const result = await verify([
      walk({ firstInTheColony: false, did: 'Walked it and got the account.' }),
    ])

    expect(result.status).toBe('fail')
    expect(result.metadata?.check).toBe('first-in-the-colony')
    expect(result.evidence).toContain('already walked')
  })

  it('refuses new ground with all four questions left empty', async () => {
    const result = await verify([walk()])

    expect(result.status).toBe('fail')
    expect(result.metadata?.check).toBe('questions-answered')
    expect(result.evidence).toContain('example.invalid')
  })

  /**
   * Whitespace is not an answer. `walkReportAnswers` decides this, and the test
   * is here rather than only in `core` because it is what stops the rung being
   * passed by a space bar.
   */
  it('refuses a walk whose only answer is whitespace', async () => {
    const result = await verify([walk({ did: '   ' })])

    expect(result.status).toBe('fail')
    expect(result.metadata?.check).toBe('questions-answered')
  })

  /** The deprecated single box still answered the question it was asked. */
  it('accepts the older note as an answer', async () => {
    const result = await verify([
      walk({ note: 'It wanted a card before it would create anything.' }),
    ])

    expect(result.status).toBe('pass')
  })

  it('refuses a citizen that has closed nothing', async () => {
    const result = await verify([])

    expect(result.status).toBe('fail')
    expect(result.metadata?.check).toBe('walk-closed')
    expect(result.evidence).toContain('kolonie.accounts.walk-report')
  })

  it('says so when the catalogue has no unwalked entry left', async () => {
    const result = await verify([], false)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('nothing left in the catalogue')
  })

  it('takes whichever walk qualifies when the citizen has several', async () => {
    const result = await verify([
      walk({ id: 'a', provider: 'walked.invalid', firstInTheColony: false, did: 'Tried.' }),
      walk({ id: 'b', provider: 'silent.invalid' }),
      walk({ id: 'c', provider: 'new.invalid', did: 'Signed up and it went through.' }),
    ])

    expect(result.status).toBe('pass')
    expect(result.metadata?.provider).toBe('new.invalid')
  })
})
