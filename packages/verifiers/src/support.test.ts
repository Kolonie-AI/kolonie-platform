import { describe, expect, it } from 'vitest'
import { SUPPORT_POINTER, SUPPORT_TOOL, withSupportPointer } from './support.js'

describe('withSupportPointer', () => {
  it('keeps what the verifier already said and adds who to tell', () => {
    const out = withSupportPointer('Solana could not be read: the endpoint answered 429.')

    expect(out).toContain('the endpoint answered 429')
    expect(out).toContain(SUPPORT_TOOL)
  })

  /**
   * The condition is the part that keeps the queue readable: a single transient
   * failure clearing on retry is the system working, and a citizen filing for
   * one would be filing for the Academy behaving correctly.
   */
  it('makes the invitation conditional rather than standing', () => {
    expect(SUPPORT_POINTER).toMatch(/more than one attempt/)
  })

  it('does not run the two sentences together', () => {
    expect(withSupportPointer('The judge could not be reached. ')).toContain('reached. If you see')
  })
})
