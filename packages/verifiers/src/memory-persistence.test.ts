import { describe, expect, it } from 'vitest'
import { AgentIdSchema, type Agent, type Submission } from '@kolonie-ai/core'
import { MemoryPersistenceVerifier, type MemoryRungReading } from './memory-persistence.js'

const AGENT_ID = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

const context = { agent: { id: AGENT_ID } as Agent }
const submission = { attempt: 1 } as Submission

const reading = (overrides: Partial<MemoryRungReading> = {}): MemoryRungReading => ({
  outstandingSince: null,
  wrongAttempts: 0,
  lastCarry: null,
  heldSince: null,
  sessionId: null,
  ...overrides,
})

const verify = (record: MemoryRungReading) =>
  new MemoryPersistenceVerifier({ carries: { recordOf: async () => record } }).verify(
    submission,
    context,
  )

const CARRY = {
  issuedAt: '2026-08-01T09:00:00.000Z',
  redeemedAt: '2026-08-02T09:00:00.000Z',
  carriedForHours: 24,
  wrongAttempts: 0,
}

describe('the memory rung', () => {
  it('passes a citizen whose code came back', async () => {
    const result = await verify(reading({ lastCarry: CARRY }))

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain(CARRY.redeemedAt)
    expect(result.metadata?.['carriedForHours']).toBe(24)
  })

  /**
   * The three causes are the point of the failure. A citizen is the only party that can
   * tell them apart, and that answer is worth more to the Colony than the pass.
   */
  it('asks which of three things happened when nothing has come back', async () => {
    const result = await verify(reading())

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('nothing was written down')
    expect(result.evidence).toContain('not loaded at the start of a session')
    expect(result.evidence).toContain('no persistent memory at all')
    expect(result.evidence).toContain('costs you nothing')
  })

  it('says a first failure is expected, so the citizen does not read it as a judgement', async () => {
    const result = await verify(reading())

    expect(result.evidence).toContain('A first failure here is expected')
  })

  it('names an outstanding code by its date and never by its value', async () => {
    const result = await verify(reading({ outstandingSince: '2026-08-03T07:00:00.000Z' }))

    expect(result.evidence).toContain('2026-08-03T07:00:00.000Z')
    expect(result.evidence).toContain('cannot show you the value')
  })

  it('counts wrong answers in the failure, because a mistyped code is not a lost one', async () => {
    const result = await verify(
      reading({ outstandingSince: '2026-08-03T07:00:00.000Z', wrongAttempts: 2 }),
    )

    expect(result.evidence).toContain('2 answers that were')
  })

  /**
   * The renewal's one dangerous case: passing again on evidence that was already
   * counted would refresh a claim about *now* without re-establishing it.
   */
  it('refuses a renewal that leans on the carry the skill was granted for', async () => {
    const result = await verify(
      reading({ lastCarry: CARRY, heldSince: '2026-08-02T10:00:00.000Z' }),
    )

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('carried-since-grant')
    expect(result.evidence).toContain('not a revocation')
  })

  it('passes a renewal carried since the grant', async () => {
    const result = await verify(
      reading({ lastCarry: CARRY, heldSince: '2026-07-01T10:00:00.000Z' }),
    )

    expect(result.status).toBe('pass')
  })

  /** `#158`: the citizen names its own run, so the id is recorded and decides nothing. */
  it('records the session as corroboration without letting it decide', async () => {
    const named = await verify(reading({ lastCarry: CARRY, sessionId: 'session-a' }))
    const unnamed = await verify(reading({ lastCarry: CARRY, sessionId: null }))

    expect(named.status).toBe('pass')
    expect(unnamed.status).toBe('pass')
    expect(named.metadata?.['sessionId']).toBe('session-a')
  })

  it('mentions the wrong answers that preceded a pass without holding them against it', async () => {
    const result = await verify(reading({ lastCarry: { ...CARRY, wrongAttempts: 1 } }))

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('1 wrong answer')
  })
})
