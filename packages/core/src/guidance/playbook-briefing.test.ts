import { describe, expect, it } from 'vitest'
import { BRIEFING_CLAIM_MAX_LENGTH, isCurrentClaim } from './briefing.js'
import {
  PlaybookBriefingClaimSchema,
  PlaybookBriefingSectionSchema,
  type PlaybookBriefingClaim,
} from './playbook-briefing.js'

const NOW = '2026-08-18T12:00:00.000Z'

const aClaim = (overrides: Partial<PlaybookBriefingClaim> = {}): PlaybookBriefingClaim => ({
  section: 'route',
  text: 'Step 2 clears when the mailbox is already proved.',
  reports: 1,
  platforms: { openclaw: 1 },
  lastSupportedAt: NOW,
  sources: ['9a8e1e0e-2a4f-4f39-9d0d-1f0a1b2c3d4e'],
  ...overrides,
})

describe('playbook briefing sections', () => {
  it('names the four sections a playbook claim can answer', () => {
    expect(PlaybookBriefingSectionSchema.options).toEqual(['step', 'route', 'yield', 'unsolved'])
  })

  it('refuses the task-side wall section — playbooks have no wall at that grain', () => {
    expect(PlaybookBriefingSectionSchema.safeParse('wall').success).toBe(false)
  })
})

describe('what a stored playbook claim has to be', () => {
  it('accepts a route claim with the shared length bound', () => {
    expect(PlaybookBriefingClaimSchema.safeParse(aClaim()).success).toBe(true)
    expect(BRIEFING_CLAIM_MAX_LENGTH).toBe(400)
  })

  it('accepts a step claim that names its position', () => {
    expect(
      PlaybookBriefingClaimSchema.safeParse(
        aClaim({ section: 'step', stepPosition: 2, text: 'The OAuth redirect loops on step 2.' }),
      ).success,
    ).toBe(true)
  })

  it('accepts a yield claim — unverified citizen report of what came back', () => {
    expect(
      PlaybookBriefingClaimSchema.safeParse(
        aClaim({
          section: 'yield',
          text: 'Three runners reported replies landing in the inbox within a day.',
        }),
      ).success,
    ).toBe(true)
  })

  it('refuses a claim with no source behind it', () => {
    expect(PlaybookBriefingClaimSchema.safeParse(aClaim({ sources: [] })).success).toBe(false)
  })

  it('refuses a claim whose text is blank', () => {
    expect(PlaybookBriefingClaimSchema.safeParse(aClaim({ text: '   ' })).success).toBe(false)
  })

  it('refuses a section nobody defined', () => {
    expect(
      PlaybookBriefingClaimSchema.safeParse(
        aClaim({ section: 'a section nobody defined' as 'route' }),
      ).success,
    ).toBe(false)
  })

  it('refuses text longer than the shared claim bound', () => {
    expect(
      PlaybookBriefingClaimSchema.safeParse(
        aClaim({ text: 'x'.repeat(BRIEFING_CLAIM_MAX_LENGTH + 1) }),
      ).success,
    ).toBe(false)
  })
})

describe('isCurrentClaim reused unchanged for playbook claims', () => {
  it('keeps a claim current when too few runs have closed to bound it', () => {
    expect(
      isCurrentClaim(
        { lastSupportedAt: '2020-01-01T00:00:00.000Z' },
        { oldestCurrentAttempt: null, now: NOW },
      ),
    ).toBe(true)
  })
})
