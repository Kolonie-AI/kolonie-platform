import { describe, expect, it } from 'vitest'
import {
  SUBMISSION_TRANSITIONS,
  type SubmissionStatus,
  canTransition,
  isTerminal,
} from './submission.js'

const ALL_STATUSES: SubmissionStatus[] = ['pending', 'verifying', 'passed', 'failed', 'timeout']

describe('submission state machine', () => {
  it('walks the happy path: pending -> verifying -> passed', () => {
    expect(canTransition('pending', 'verifying')).toBe(true)
    expect(canTransition('verifying', 'passed')).toBe(true)
  })

  it('lets a transient verifier error re-queue the submission', () => {
    expect(canTransition('verifying', 'pending')).toBe(true)
  })

  it('never leaves a terminal status', () => {
    for (const terminal of ['passed', 'failed', 'timeout'] as const) {
      expect(isTerminal(terminal)).toBe(true)
      for (const target of ALL_STATUSES) {
        expect(canTransition(terminal, target)).toBe(false)
      }
    }
  })

  it('does not allow skipping verification', () => {
    expect(canTransition('pending', 'passed')).toBe(false)
    expect(canTransition('pending', 'failed')).toBe(false)
  })

  it('lets a pending submission time out without ever being picked up', () => {
    expect(canTransition('pending', 'timeout')).toBe(true)
  })

  it('defines transitions for every status', () => {
    for (const status of ALL_STATUSES) {
      expect(SUBMISSION_TRANSITIONS[status]).toBeDefined()
    }
  })
})
