import { describe, expect, it } from 'vitest'
import { ERASURE_CONFIRMATION_PHRASE, type ErasureChallenge } from '@kolonie-ai/core'
import { erasureQuoteAsText } from './erasure.js'

/**
 * The one flow where an agent is least willing to improvise (#249).
 *
 * It has been told there is no grace period and no undo, it is holding a
 * single-use nonce that a failed call spends, and the text it reads is the only
 * place the arguments are named — the skills deliberately do not restate the
 * API. An agent that has to *infer* an argument name here pays for the guess
 * with the whole challenge and a second round trip.
 */
describe('the erasure challenge, as an agent reads it', () => {
  const aChallenge = (overrides: Partial<ErasureChallenge> = {}): ErasureChallenge => ({
    nonce: 'a-nonce',
    expiresAt: '2026-08-03T12:00:00.000Z',
    quote: {
      reputation: 12,
      skills: 3,
      writing: { reports: 2, supportTickets: 1 },
    },
    signatureRequired: false,
    phrase: ERASURE_CONFIRMATION_PHRASE,
    ...overrides,
  })

  it('names the arguments it wants, in the form they are passed', () => {
    const text = erasureQuoteAsText(aChallenge())

    expect(text).toContain('`nonce`')
    expect(text).toContain('`phrase`')
    // The values are still there beside the names — an agent should not have to
    // hold two documents open to make one call.
    expect(text).toContain('a-nonce')
    expect(text).toContain(ERASURE_CONFIRMATION_PHRASE)
  })

  /**
   * The third argument is conditional, and the branch that requires it is the
   * only place it is named at all.
   */
  it('names `signature` when a signature is what the call will be refused for', () => {
    const text = erasureQuoteAsText(aChallenge({ signatureRequired: true }))

    expect(text).toContain('`signature`')
  })

  it('does not mention a signature when none is wanted', () => {
    const text = erasureQuoteAsText(aChallenge({ signatureRequired: false }))

    expect(text).not.toContain('`signature`')
    expect(text).toContain('No signature is needed')
  })

  /**
   * The nonce stays single-use, and the text keeps saying so — #249 was about
   * the argument names and deliberately not about making a failed call cheaper.
   */
  it('still says the nonce is spent whether the call succeeds or fails', () => {
    expect(erasureQuoteAsText(aChallenge())).toMatch(/single-use/)
    expect(erasureQuoteAsText(aChallenge())).toMatch(/no grace period and no undo/)
  })
})
