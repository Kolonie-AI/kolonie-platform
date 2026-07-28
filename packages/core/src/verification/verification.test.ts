import { describe, expect, it } from 'vitest'
import { VerificationSchema } from './verification.js'

const record = (overrides: Record<string, unknown> = {}) => ({
  id: '7d6c5b4a-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
  submissionId: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  taskType: 'example-task',
  status: 'pass',
  evidence: 'The payload carried a well-formed echo.',
  metadata: { attempt: 1 },
  createdAt: '2026-07-28T12:00:00.000Z',
  ...overrides,
})

describe('VerificationSchema', () => {
  it('accepts a complete record', () => {
    expect(VerificationSchema.parse(record()).taskType).toBe('example-task')
  })

  /**
   * The one thing this shape exists to make impossible. A reward with no stated
   * grounds cannot be reviewed by anyone, which is the same objection
   * `AGENTS.md` §6 makes to a verifier that pays out its own results.
   */
  it('refuses a verdict with no evidence', () => {
    expect(VerificationSchema.safeParse(record({ evidence: '' })).success).toBe(false)
  })

  it('refuses the submission lifecycle vocabulary, which is not the verifier’s', () => {
    // `passed` is what a submission becomes; `pass` is what a verifier returns.
    expect(VerificationSchema.safeParse(record({ status: 'passed' })).success).toBe(false)
  })

  /** A verifier that offered no proof leaves null, and null is not `{}`. */
  it('keeps the absence of metadata distinguishable from empty metadata', () => {
    expect(VerificationSchema.parse(record({ metadata: null })).metadata).toBeNull()
    expect(VerificationSchema.parse(record({ metadata: {} })).metadata).toEqual({})
  })

  it('requires metadata to be present, even as null', () => {
    const { metadata: _omitted, ...withoutMetadata } = record()
    expect(VerificationSchema.safeParse(withoutMetadata).success).toBe(false)
  })
})
