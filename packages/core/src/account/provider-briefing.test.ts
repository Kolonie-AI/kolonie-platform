import { describe, expect, it } from 'vitest'
import { CURRENT_CLAIM_DAYS } from '../guidance/briefing.js'
import { AccountKindSchema, AccountProviderSchema } from './account.js'
import {
  ProviderBriefingClaimSchema,
  isCurrentProviderClaim,
  providerBriefingAgeHours,
  providerClaimsIn,
  type ProviderBriefing,
  type ServedProviderBriefingClaim,
} from './provider-briefing.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = '2026-08-13T12:00:00.000Z'
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString()

const aClaim = (
  overrides: Partial<ServedProviderBriefingClaim> = {},
): ServedProviderBriefingClaim => ({
  section: 'wall',
  text: 'Signup asks for a phone number on the last step.',
  walks: 1,
  platforms: { openclaw: 1 },
  lastSupportedAt: NOW,
  sources: ['9a8e1e0e-2a4f-4f39-9d0d-1f0a1b2c3d4e'],
  current: true,
  ...overrides,
})

describe('whether a provider claim is current', () => {
  /**
   * The walk bound cannot bind on a provider nobody has walked twenty times,
   * which is most of them — so the answer has to be *current* rather than a
   * comparison against a timestamp that does not exist.
   */
  it('keeps a claim current when too few walks have finished to bound it', () => {
    expect(
      isCurrentProviderClaim(
        { lastSupportedAt: ago(CURRENT_CLAIM_DAYS * 3) },
        { oldestCurrentWalk: null, now: NOW },
      ),
    ).toBe(true)
  })

  it('keeps a claim current when a walk inside the window supported it', () => {
    expect(
      isCurrentProviderClaim(
        { lastSupportedAt: ago(400) },
        { oldestCurrentWalk: ago(500), now: NOW },
      ),
    ).toBe(true)
  })

  /** The two bounds are an *or*: the more generous one decides. */
  it('keeps a claim current past the walk bound while it is inside the day bound', () => {
    expect(
      isCurrentProviderClaim(
        { lastSupportedAt: ago(CURRENT_CLAIM_DAYS - 1) },
        { oldestCurrentWalk: ago(1), now: NOW },
      ),
    ).toBe(true)
  })

  it('demotes a claim that fails both bounds', () => {
    expect(
      isCurrentProviderClaim(
        { lastSupportedAt: ago(CURRENT_CLAIM_DAYS + 1) },
        { oldestCurrentWalk: ago(1), now: NOW },
      ),
    ).toBe(false)
  })

  /** The walk bound is inclusive: the nth walk itself still supports the claim. */
  it('counts a claim supported exactly at the oldest current walk', () => {
    expect(
      isCurrentProviderClaim(
        { lastSupportedAt: ago(30) },
        { oldestCurrentWalk: ago(30), now: NOW },
      ),
    ).toBe(true)
  })
})

describe('reading a provider briefing', () => {
  const briefing: ProviderBriefing = {
    kind: AccountKindSchema.parse('mailbox'),
    provider: AccountProviderSchema.parse('somewhere.example'),
    claims: [
      aClaim({ section: 'wall', text: 'first wall' }),
      aClaim({ section: 'route', text: 'the route' }),
      aClaim({ section: 'wall', text: 'second wall' }),
    ],
    model: 'fake/test-model',
    writtenAt: ago(0.5),
  }

  it('answers one section in the order the synthesis put it', () => {
    expect(providerClaimsIn(briefing, 'wall').map((claim) => claim.text)).toEqual([
      'first wall',
      'second wall',
    ])
  })

  it('answers with nothing for a section nothing was written under', () => {
    expect(providerClaimsIn(briefing, 'unsolved')).toEqual([])
  })

  it('states the age in whole hours', () => {
    expect(providerBriefingAgeHours(briefing, Date.parse(NOW))).toBe(12)
  })

  /**
   * A briefing written a moment ago must not read as one hour old and must never
   * read as a negative age — the number is served to a reader deciding whether to
   * trust the sentence above it.
   */
  it('never states a negative age', () => {
    expect(
      providerBriefingAgeHours({ ...briefing, writtenAt: NOW }, Date.parse(NOW) - 60_000),
    ).toBe(0)
  })
})

describe('what a stored claim has to be', () => {
  it('refuses a claim with no walk behind it', () => {
    expect(ProviderBriefingClaimSchema.safeParse({ ...aClaim(), sources: [] }).success).toBe(false)
  })

  it('refuses a claim whose text is blank', () => {
    expect(ProviderBriefingClaimSchema.safeParse({ ...aClaim(), text: '   ' }).success).toBe(false)
  })

  it('refuses a section nobody defined', () => {
    expect(
      ProviderBriefingClaimSchema.safeParse({ ...aClaim(), section: 'a section nobody defined' })
        .success,
    ).toBe(false)
  })
})
