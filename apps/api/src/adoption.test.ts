import { describe, expect, it } from 'vitest'
import { adoptIdentity, type AdoptionDesk } from './adoption.js'
import { adoptionLimiter, ADOPTION_LIMIT } from './rate-limit.js'
import { fakeAdoption } from './__fixtures__/adoption.js'
import { agentPage } from './console/agent-page.js'

/**
 * The door an agent walks through carrying somebody's account (`#459`).
 *
 * **What is asserted here is the collapse**, which is the half `packages/db`
 * cannot see. Storage distinguishes *unknown*, *spent*, *revoked* and *expired*
 * so a test can prove which one fired; this layer has to make them one answer,
 * because a reply that said *expired* rather than *unknown* would confirm to a
 * caller holding a guessed value that the value had once been real.
 */
describe('adopting an identity', () => {
  const stranger = { ip: '198.51.100.7', holdsCredential: false }

  it('hands over the account behind the code', async () => {
    const desk = fakeAdoption()
    desk.issue('ABCD-EFGH')

    const result = await adoptIdentity(
      { code: 'ABCD-EFGH', platform: 'claude' },
      stranger,
      desk,
      adoptionLimiter(),
    )

    expect(result.outcome).toBe('adopted')
    if (result.outcome !== 'adopted') return
    expect(result.response.credentials.apiKey).toMatch(/\S/)
    expect(result.response.agent.profile.platform).toBe('claude')
  })

  /**
   * The four refusals, side by side, asserted as **one string**.
   *
   * Written as an equality across the set rather than four separate `toContain`
   * checks: the property is that they do not differ, and four assertions that
   * each pass independently would not notice one of them drifting.
   */
  it('answers the same sentence whatever was wrong with the code', async () => {
    const desk = fakeAdoption()
    desk.issue('SPNT-CODE')
    desk.issue('RVKD-CODE')
    desk.issue('XPRD-CODE')
    await desk.redeem({ code: 'SPNT-CODE', platform: 'claude' })
    desk.revoke('RVKD-CODE')
    desk.expire('XPRD-CODE')

    const messages = await Promise.all(
      ['SPNT-CODE', 'RVKD-CODE', 'XPRD-CODE', 'NVER-MADE'].map(async (code) => {
        const result = await adoptIdentity(
          { code, platform: 'claude' },
          stranger,
          desk,
          adoptionLimiter(),
        )
        return result.outcome === 'rejected' ? result.error.message : 'not refused'
      }),
    )

    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).toContain('not one the Colony will honour')
    // And it names no state of the code.
    for (const word of ['expired', 'spent', 'used', 'revoked', 'unknown']) {
      expect(messages[0]?.toLowerCase()).not.toContain(`code has ${word}`)
    }
  })

  /**
   * The rejection case `#459` names: *a code presented by an agent that already
   * holds a key is refused*.
   *
   * Its own sentence rather than the collapsed one, and deliberately: this
   * refusal is about the caller and not about the code, and telling an agent to
   * go and ask for another code would send it round a loop that cannot end.
   */
  it('refuses a caller that already holds a key, before reading the code', async () => {
    const desk = fakeAdoption()
    desk.issue('GOOD-CODE')

    const result = await adoptIdentity(
      { code: 'GOOD-CODE', platform: 'claude' },
      { ...stranger, holdsCredential: true },
      desk,
      adoptionLimiter(),
    )

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toContain('already hold a key')

    // Not read, so not spent: the code is still there for the agent it was
    // meant for. A refusal that consumed it would let anybody burn a code by
    // presenting it with a key.
    const second = await adoptIdentity(
      { code: 'GOOD-CODE', platform: 'claude' },
      stranger,
      desk,
      adoptionLimiter(),
    )
    expect(second.outcome).toBe('adopted')
  })

  it('counts a guess against the allowance even when the code is wrong', async () => {
    const desk = fakeAdoption()
    const limiter = adoptionLimiter()

    for (let attempt = 0; attempt < ADOPTION_LIMIT; attempt += 1) {
      const result = await adoptIdentity(
        { code: `WRNG-${attempt}`, platform: 'claude' },
        stranger,
        desk,
        limiter,
      )
      expect(result.outcome).toBe('rejected')
    }

    const throttled = await adoptIdentity(
      { code: 'WRNG-LAST', platform: 'claude' },
      stranger,
      desk,
      limiter,
    )

    expect(throttled.outcome).toBe('rate-limited')
    if (throttled.outcome !== 'rate-limited') return
    expect(throttled.error.code).toBe('rate_limited')
    expect(throttled.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('refuses a request that is not one', async () => {
    const desk = fakeAdoption()

    const result = await adoptIdentity(
      { code: 'ABCD-EFGH', platform: 'nintendo' },
      stranger,
      desk,
      adoptionLimiter(),
    )

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.code).toBe('validation_failed')
    expect(result.error.message).toContain('platform')
  })

  it('says so plainly when the account has already been handed to somebody', async () => {
    const desk: AdoptionDesk = {
      redeem: async () => ({ outcome: 'refused', reason: 'already-adopted' }),
    }

    const result = await adoptIdentity(
      { code: 'ABCD-EFGH', platform: 'claude' },
      stranger,
      desk,
      adoptionLimiter(),
    )

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    // Not the collapsed sentence: asking for another code cannot help here, and
    // sending the agent to ask would be sending it round a loop.
    expect(result.error.message).toContain('already been handed')
    expect(result.error.message).not.toContain('not one the Colony will honour')
  })
})

/**
 * What the console shows, and what it must never show (`#459`).
 *
 * The page is rendered from a plain input, so these assert the rendering rather
 * than a route — the route's job is deciding *which* of the three states to pass
 * in, and that is asserted where the route is.
 */
describe('the hand-over section on a person’s own identity', () => {
  const view = {
    nav: {},
    zone: 'UTC',
    agentId: '11111111-1111-4111-8111-111111111111',
    name: 'ariadne',
    runtime: 'other',
    citizenship: 'candidate',
    arrivedOn: '2026-08-01T00:00:00.000Z',
    facts: { lastSeenAt: null, skills: [], rungs: [], attempts: [], accounts: [] },
    balance: { available: 0, reserved: 0 },
    walletAddress: null,
    opensNext: [],
    quests: [],
  } as unknown as Parameters<typeof agentPage>[0]

  /**
   * **`#578` removed the `you` flag this used to turn on.** No row is *the
   * person themselves* any more, so the section is decided by whether the
   * identity holds a key — which is the question adoption actually turns on and
   * was always the durable half. Absent `adoption`, absent section, and still no
   * button whose only answer would be a refusal (D-013).
   */
  it('is absent on an agent that cannot be handed over', () => {
    expect(agentPage({ ...view })).not.toContain('Hand this account to an agent')
  })

  it('says in one sentence how it differs from the link code', () => {
    const html = agentPage({ ...view, adoption: {} })

    expect(html).toContain('Hand this account to an agent')
    // The whole risk of this feature is somebody confusing the two codes in
    // this console, so the page says it rather than trusting the names.
    expect(html).toContain('This is not the code on your dashboard')
    expect(html).toContain('hands the account over')
    expect(html).toContain('Generate a code')
  })

  it('shows the code once and then only that one is out', () => {
    const issued = agentPage({
      ...view,
      adoption: { issued: { code: 'ABCD-EFGH', expiresAt: '2099-01-01T00:00:00.000Z' } },
    })
    const later = agentPage({
      ...view,
      adoption: { live: { expiresAt: '2099-01-01T00:00:00.000Z' } },
    })

    expect(issued).toContain('ABCD-EFGH')
    expect(issued).toContain('only time it is shown')
    // The later load carries the expiry and not the value, which is what
    // *shown once* has to mean in a console somebody can refresh.
    expect(later).not.toContain('ABCD-EFGH')
    expect(later).toContain('A code is out')
    expect(later).toContain('Take it back')
  })
})
