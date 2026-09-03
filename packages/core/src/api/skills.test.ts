import { describe, expect, it } from 'vitest'
import {
  SetSkillNoteRequestSchema,
  SetSkillNoteResponseSchema,
  SKILL_NOTE_ADVISORY_THRESHOLD,
} from './skills.js'

describe('skill note budget and replacement schemas', () => {
  it('accepts an optional expected version and complete read metadata', () => {
    expect(
      SetSkillNoteRequestSchema.parse({ note: 'Current procedure.', expectedVersion: 3 }),
    ).toEqual({ note: 'Current procedure.', expectedVersion: 3 })
    expect(
      SetSkillNoteResponseSchema.parse({
        entry: {
          skill: 'browser',
          note: 'Current procedure.',
          writtenAt: '2026-09-03T09:00:00.000Z',
          version: 4,
        },
        metadata: {
          characters: 18,
          maximum: 2000,
          advisoryThreshold: SKILL_NOTE_ADVISORY_THRESHOLD,
          overAdvisoryThreshold: false,
          writtenAt: '2026-09-03T09:00:00.000Z',
          version: 4,
        },
        lengthChange: 'grew',
      }).metadata.version,
    ).toBe(4)
  })

  it('rejects non-positive replacement versions and incomplete budget metadata', () => {
    expect(
      SetSkillNoteRequestSchema.safeParse({ note: 'Current procedure.', expectedVersion: 0 })
        .success,
    ).toBe(false)
    expect(
      SetSkillNoteResponseSchema.safeParse({
        entry: null,
        metadata: { characters: 0, maximum: 2000 },
        lengthChange: null,
      }).success,
    ).toBe(false)
  })
})
