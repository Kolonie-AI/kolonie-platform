import { describe, expect, it } from 'vitest'
import {
  MEMORY_CODE_ALPHABET,
  MEMORY_CODE_LENGTH,
  memoryCodesMatch,
  MemoryCodeSchema,
  mintMemoryCode,
  normalizeMemoryCode,
} from './memory-code.js'

/**
 * The rung's one piece of arithmetic, and the only part of it that can be wrong without
 * anybody noticing: a code an agent cannot copy correctly turns a memory failure into a
 * transcription failure, and the two are indistinguishable in the record.
 */
describe('the memory code', () => {
  it('is drawn from an alphabet with no confusable character in it', () => {
    for (const confusable of ['I', 'L', 'O', '0', '1']) {
      expect(MEMORY_CODE_ALPHABET).not.toContain(confusable)
    }
  })

  it('mints codes of the declared length, in groups', () => {
    const code = mintMemoryCode()

    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
    expect(normalizeMemoryCode(code)).toHaveLength(MEMORY_CODE_LENGTH)
  })

  it('mints a different code every time', () => {
    const minted = new Set(Array.from({ length: 200 }, () => mintMemoryCode()))

    // Two collisions in 200 draws would be a bias worth failing over; one would be
    // roughly a 1-in-10^10 accident.
    expect(minted.size).toBe(200)
  })

  it('uses every character of its alphabet and nothing else', () => {
    const seen = new Set(
      Array.from({ length: 400 }, () => normalizeMemoryCode(mintMemoryCode())).join(''),
    )

    expect([...seen].sort().join('')).toBe([...MEMORY_CODE_ALPHABET].sort().join(''))
  })

  it('forgives the case and the separator, because both survive a copy', () => {
    const code = 'ABCDE-FGHJK'

    expect(memoryCodesMatch(code, 'abcde-fghjk')).toBe(true)
    expect(memoryCodesMatch(code, 'ABCDEFGHJK')).toBe(true)
    expect(memoryCodesMatch(code, 'ABCDE FGHJK')).toBe(true)
    expect(memoryCodesMatch(code, '  abcde fghjk  ')).toBe(true)
  })

  it('does not forgive a wrong character', () => {
    expect(memoryCodesMatch('ABCDE-FGHJK', 'ABCDE-FGHJM')).toBe(false)
    expect(memoryCodesMatch('ABCDE-FGHJK', 'ABCDE-FGHJ')).toBe(false)
  })

  it('accepts what a citizen is likely to hand back rather than pre-judging it', () => {
    // The rung answers a wrong code with the three reasons it happens; a schema that
    // refused it first would answer "malformed" instead, which teaches nobody anything.
    expect(MemoryCodeSchema.safeParse('nonsense').success).toBe(true)
    expect(MemoryCodeSchema.safeParse('').success).toBe(false)
    expect(MemoryCodeSchema.safeParse('x'.repeat(65)).success).toBe(false)
  })
})
