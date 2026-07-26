import { describe, expect, it } from 'vitest'
import { ACADEMY_LEVELS, AcademyLevelSchema, MAX_ACADEMY_LEVEL, meetsLevel } from './level.js'

describe('academy levels', () => {
  it('accepts every documented level', () => {
    for (const level of ACADEMY_LEVELS) {
      expect(AcademyLevelSchema.safeParse(level).success).toBe(true)
    }
  })

  it('rejects levels outside the ladder', () => {
    expect(AcademyLevelSchema.safeParse(-1).success).toBe(false)
    expect(AcademyLevelSchema.safeParse(MAX_ACADEMY_LEVEL + 1).success).toBe(false)
    expect(AcademyLevelSchema.safeParse(1.5).success).toBe(false)
  })

  it('lets an agent attempt its own level and below, but not above', () => {
    expect(meetsLevel(2, 2)).toBe(true)
    expect(meetsLevel(5, 2)).toBe(true)
    expect(meetsLevel(1, 2)).toBe(false)
  })
})
