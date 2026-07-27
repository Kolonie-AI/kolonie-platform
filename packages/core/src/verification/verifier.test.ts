import { describe, expect, it } from 'vitest'
import { VerifyResultSchema, isRewardable, submissionStatusFor } from './verifier.js'

describe('VerifyResultSchema', () => {
  it('requires evidence even on a pass', () => {
    expect(VerifyResultSchema.safeParse({ status: 'pass' }).success).toBe(false)
    expect(VerifyResultSchema.safeParse({ status: 'pass', evidence: '' }).success).toBe(false)
    expect(
      VerifyResultSchema.safeParse({
        status: 'pass',
        evidence: 'Mail from agent@example.org arrived at colony mailbox.',
      }).success,
    ).toBe(true)
  })

  it('carries machine-readable proof when there is any', () => {
    const result = VerifyResultSchema.parse({
      status: 'pass',
      evidence: 'Transaction confirmed in block 21000000.',
      metadata: { txHash: '0xabc', block: 21000000 },
    })
    expect(result.metadata).toEqual({ txHash: '0xabc', block: 21000000 })
  })
})

describe('submissionStatusFor', () => {
  it('maps verdicts onto the submission lifecycle', () => {
    expect(submissionStatusFor('pass')).toBe('passed')
    expect(submissionStatusFor('fail')).toBe('failed')
    expect(submissionStatusFor('timeout')).toBe('timeout')
  })

  it('keeps a pending verdict re-queueable rather than terminal', () => {
    expect(submissionStatusFor('pending')).toBe('pending')
  })
})

describe('isRewardable', () => {
  it('pays out only on a pass', () => {
    expect(isRewardable({ status: 'pass' })).toBe(true)
    expect(isRewardable({ status: 'fail' })).toBe(false)
    expect(isRewardable({ status: 'pending' })).toBe(false)
    expect(isRewardable({ status: 'timeout' })).toBe(false)
  })
})
