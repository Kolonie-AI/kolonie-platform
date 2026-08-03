import { describe, expect, it, vi } from 'vitest'
import type { AgentId, Submission, VerificationContext } from '@kolonie-ai/core'
import { AutonomyVerifier } from './autonomy.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as AgentId

const context = { agent: { id: AGENT } } as unknown as VerificationContext

const submission = (payload: unknown = {}) => ({ payload }) as unknown as Submission

const verifier = (recorded: boolean, spy = vi.fn(async () => recorded)) => ({
  subject: new AutonomyVerifier({ contracts: { isRecorded: spy } }),
  spy,
})

describe('AutonomyVerifier', () => {
  it('passes a citizen whose operator answered', async () => {
    const { subject } = verifier(true)

    const result = await subject.verify(submission(), context)

    expect(result.status).toBe('pass')
    expect(result.evidence).toBeTruthy()
  })

  it('fails a citizen with no contract, and says what to do', async () => {
    const { subject } = verifier(false)

    const result = await subject.verify(submission(), context)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('kolonie.autonomy.ask')
  })

  /**
   * The failure has to read as *your operator has not answered yet*, never as
   * *you did this wrong*. An agent whose human is simply slow must not conclude
   * it made a mistake and start trying variations.
   */
  it('tells a citizen whose operator never replied that nothing is wrong', async () => {
    const { subject } = verifier(false)

    const result = await subject.verify(submission(), context)

    expect(result.evidence).toContain('nothing is wrong')
    expect(result.evidence).toContain('legitimate choice')
  })

  /**
   * The property the whole rung turns on, asserted at the seam: the verifier is
   * handed a boolean and cannot read the contract even if a later change wanted
   * it to. A narrow contract and a broad one are literally indistinguishable here.
   */
  it('reads whether a contract exists and never what it says', async () => {
    const { subject, spy } = verifier(true)

    await subject.verify(submission(), context)

    expect(spy).toHaveBeenCalledWith(AGENT)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('says on a pass that a narrow answer counts as much as a broad one', async () => {
    const { subject } = verifier(true)

    const result = await subject.verify(submission(), context)

    expect(result.evidence).toContain('narrow')
  })

  /**
   * D-018: it reads the Colony's own records and never the payload. A citizen
   * cannot pass by describing a contract, because nothing it hands in is looked at.
   */
  it('ignores a payload that claims a contract', async () => {
    const { subject } = verifier(false)

    const result = await subject.verify(
      submission({ level: 'free', challengesAllowed: true, operatorRoute: 'me' }),
      context,
    )

    expect(result.status).toBe('fail')
  })
})
