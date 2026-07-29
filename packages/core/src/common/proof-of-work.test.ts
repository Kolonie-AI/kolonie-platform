import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  leadingZeroBits,
  POW_MAX_NONCE_LENGTH,
  powCheck,
  powPreimage,
  PowNonceSchema,
  solvesChallenge,
} from './proof-of-work.js'

describe('powPreimage', () => {
  /**
   * The separator is part of the contract, not a detail. Without it, an input
   * ending where a nonce begins is ambiguous — and while the input is
   * fixed-length today, a rule that holds only because of a length nobody wrote
   * down is one an unrelated change eventually breaks.
   */
  it('separates the Colony’s half from the agent’s', () => {
    expect(powPreimage('ab', 'cd')).toBe('ab:cd')
    expect(powPreimage('ab', 'cd')).not.toBe(powPreimage('abc', 'd'))
  })
})

describe('leadingZeroBits', () => {
  it('counts bits, not bytes and not hex characters', () => {
    expect(leadingZeroBits(Uint8Array.from([0b1000_0000]))).toBe(0)
    // The distinction an agent gets wrong first: one zero hex character is four
    // zero bits, not one.
    expect(leadingZeroBits(Uint8Array.from([0b0000_1111]))).toBe(4)
    expect(leadingZeroBits(Uint8Array.from([0b0000_0001]))).toBe(7)
    expect(leadingZeroBits(Uint8Array.from([0, 0b0100_0000]))).toBe(9)
  })

  it('counts every bit of an all-zero digest rather than stopping early', () => {
    expect(leadingZeroBits(new Uint8Array(32))).toBe(256)
  })
})

describe('powCheck', () => {
  const input = 'a'.repeat(64)

  /** The search an agent runs, at a target cheap enough for a unit test. */
  const solve = (difficulty: number): string => {
    for (let attempt = 0; attempt < 1_000_000; attempt++) {
      if (solvesChallenge(input, String(attempt), difficulty)) return String(attempt)
    }
    throw new Error('no nonce found')
  }

  it('agrees with the digest an agent computes for itself', () => {
    const nonce = solve(8)

    // The whole appeal of this rung is that both sides compute the same number,
    // so the evidence has to be reproducible with a plain hash and nothing else.
    expect(powCheck(input, nonce, 8).digest).toBe(
      createHash('sha256').update(`${input}:${nonce}`).digest('hex'),
    )
  })

  it('meets a target it clears and misses one it does not', () => {
    const nonce = solve(8)
    const checked = powCheck(input, nonce, 8)

    expect(checked.meets).toBe(true)
    expect(checked.bits).toBeGreaterThanOrEqual(8)
    // The same nonce against a harder target: the answer is a fact about the
    // digest and the number it is compared to, not about the nonce alone.
    expect(powCheck(input, nonce, checked.bits + 1).meets).toBe(false)
  })

  it('reports the bits it found, so a near miss is legible', () => {
    const checked = powCheck(input, 'certainly-not-a-solution', 32)

    expect(checked.meets).toBe(false)
    expect(checked.bits).toBe(leadingZeroBits(Buffer.from(checked.digest, 'hex')))
  })

  it('is decided by the input as well as the nonce', () => {
    const nonce = solve(8)

    // Which is what makes a solution unusable by another agent: every agent is
    // set its own input, so a nonce is meaningless away from it.
    expect(solvesChallenge(`${input}0`, nonce, 8)).toBe(false)
  })
})

describe('PowNonceSchema', () => {
  it('takes any string an agent might have searched with', () => {
    expect(PowNonceSchema.parse('0')).toBe('0')
    expect(PowNonceSchema.parse('a word')).toBe('a word')
  })

  it('refuses an empty nonce and one too long to be a search result', () => {
    expect(PowNonceSchema.safeParse('').success).toBe(false)
    expect(PowNonceSchema.safeParse('x'.repeat(POW_MAX_NONCE_LENGTH + 1)).success).toBe(false)
  })
})
