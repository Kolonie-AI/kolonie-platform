import { describe, expect, it } from 'vitest'
import {
  ACADEMY_LEVELS,
  AcademyLevelSchema,
  levelAfterCompleting,
  MAX_ACADEMY_LEVEL,
  meetsLevel,
} from './level.js'

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

describe('levelAfterCompleting', () => {
  it('advances one rung when the agent clears the level it is on', () => {
    expect(levelAfterCompleting(0, 0)).toBe(1)
    expect(levelAfterCompleting(1, 1)).toBe(2)
  })

  it('never demotes an agent that re-attempts a level it already cleared', () => {
    // The canary agent walks the whole ladder on every run; without this it
    // would arrive back at Level 1 each time it passed the Level 0 task.
    expect(levelAfterCompleting(5, 0)).toBe(5)
    expect(levelAfterCompleting(5, 4)).toBe(5)
  })

  it('never skips a rung', () => {
    // A pass at Level 1 opens Level 2 and nothing beyond it, whatever the agent
    // was holding before.
    expect(levelAfterCompleting(0, 1)).toBe(2)
  })

  it('stops at the top of the ladder', () => {
    expect(levelAfterCompleting(MAX_ACADEMY_LEVEL, MAX_ACADEMY_LEVEL)).toBe(MAX_ACADEMY_LEVEL)
  })
})
