import { describe, expect, it } from 'vitest'
import {
  OPERATOR_CLAIM_PREFIX,
  XHandleSchema,
  claimAsText,
  postCarriesClaim,
} from './operator-claim.js'

describe('XHandleSchema', () => {
  it('lowercases, because X handles are case-insensitive', () => {
    // Two rows differing only in case would be one operator counted twice, and
    // that count is what kolonie-platform#238 sells a sponsor.
    expect(XHandleSchema.parse('GregorSprint')).toBe('gregorsprint')
  })

  it('drops a leading @ so both forms a human would paste agree', () => {
    expect(XHandleSchema.parse('@gregorsprint')).toBe('gregorsprint')
    expect(XHandleSchema.parse('gregorsprint')).toBe('gregorsprint')
  })

  it('trims surrounding whitespace', () => {
    expect(XHandleSchema.parse('  @gregorsprint  ')).toBe('gregorsprint')
  })

  it('refuses a handle longer than X allows', () => {
    expect(XHandleSchema.safeParse('a'.repeat(16)).success).toBe(false)
  })

  it('refuses characters X does not permit in a handle', () => {
    expect(XHandleSchema.safeParse('gregor.sprint').success).toBe(false)
    expect(XHandleSchema.safeParse('gregor-sprint').success).toBe(false)
    expect(XHandleSchema.safeParse('').success).toBe(false)
  })

  it('refuses a whole profile URL, which is the obvious thing to paste', () => {
    expect(XHandleSchema.safeParse('https://x.com/gregorsprint').success).toBe(false)
  })
})

describe('claimAsText', () => {
  const claim = {
    handle: 'gregorsprint',
    postUrl: 'https://x.com/gregorsprint/status/1',
    claimedAt: '2026-08-02T14:31:00.000Z',
  }

  it('carries the date, which is what keeps this a dated event', () => {
    // The load-bearing assertion of the whole feature. Without the date this is
    // a standing claim about who controls the account, which is exactly what
    // D-018 refuses — and the refusal in `SocialNetwork` would then bind.
    expect(claimAsText(claim)).toBe('claimed by @gregorsprint on 2026-08-02')
  })

  it('never says operated by', () => {
    // *Operated by* asserts something about now that nothing checks, and that
    // would be false the day the handle changes hands.
    expect(claimAsText(claim)).not.toContain('operated by')
  })
})

describe('postCarriesClaim', () => {
  const claim = `${OPERATOR_CLAIM_PREFIX}-abc123`

  it('accepts a post with the claim among other words', () => {
    // Operators will add their own sentence, and should be able to.
    expect(postCarriesClaim(`Vouching for my agent. ${claim} — Gregor`, claim)).toBe(true)
  })

  it('refuses a post that does not carry the exact string', () => {
    expect(postCarriesClaim('Vouching for my agent.', claim)).toBe(false)
  })

  it('refuses a truncated claim', () => {
    expect(postCarriesClaim(`${OPERATOR_CLAIM_PREFIX}-abc12`, claim)).toBe(false)
  })

  it('names the Colony in the string a human is asked to publish', () => {
    // An operator asked to post 64 characters of unexplained hex under their own
    // name will reasonably decline. The prefix is what makes the post legible —
    // to the operator posting it and to anybody who reads it later.
    expect(claim.startsWith('kolonie')).toBe(true)
  })
})
