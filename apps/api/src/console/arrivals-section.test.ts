import { describe, expect, it } from 'vitest'
import { arrivalsSection } from './arrivals-section.js'
import type { Arrivals } from '@kolonie-ai/db'

/**
 * *Who arrived*, as the page draws it (`#607`).
 *
 * The rows are covered where they are produced — `packages/db`'s
 * `arrivals.test.ts`, against a real database. What is asserted here is the half
 * that only exists in the rendering: the **repeat** is visible, and the keys that
 * make it answerable never reach the page.
 */
const anAgent = (over: Partial<Arrivals['agents'][number]> = {}): Arrivals['agents'][number] =>
  ({
    name: 'canary',
    registeredAt: '2026-08-08T00:00:00.000Z',
    path: 'mcp',
    runtime: 'openclaw',
    model: null,
    country: 'DE',
    origins: 1,
    originKey: null,
    operated: false,
    operatorAgents: 0,
    operatorKey: null,
    mailboxDomain: null,
    calls: 0,
    attempts: 0,
    skills: 0,
    ...over,
  }) as Arrivals['agents'][number]

const arrivals = (over: Partial<Arrivals> = {}): Arrivals =>
  ({
    agents: [],
    people: [],
    computedAt: '2026-08-09T00:00:00.000Z',
    ...over,
  }) as Arrivals

describe('what the arrivals section says', () => {
  it('carries the fields a name and a timestamp could not', () => {
    const html = arrivalsSection(
      arrivals({
        agents: [anAgent({ runtime: 'claude', model: 'opus', country: 'DE', calls: 4, skills: 2 })],
      }),
    )

    expect(html).toContain('claude')
    expect(html).toContain('opus')
    expect(html).toContain('DE')
    expect(html).toContain('4 calls')
    expect(html).toContain('2 skills')
  })

  /**
   * *An account that registered and never called again is not a citizen, and
   * today nothing says so.* Now something does, in one word.
   */
  it('says plainly when an arrival has done nothing since', () => {
    const html = arrivalsSection(arrivals({ agents: [anAgent()] }))

    expect(html).toContain('<strong>nothing</strong>')
  })

  it('lists people beside agents, distinguishable at a glance', () => {
    const html = arrivalsSection(
      arrivals({
        agents: [anAgent()],
        people: [
          {
            registeredAt: '2026-08-08T00:00:00.000Z',
            provider: 'google',
            addressKnown: true,
            emailDomain: 'example.org',
            agentsOperated: 2,
            lastSeenAt: null,
          },
        ],
      }),
    )

    expect(html).toContain('<h3>Agents</h3>')
    expect(html).toContain('<h3>People</h3>')
    expect(html).toContain('google')
    expect(html).toContain('verified')
    expect(html).toContain('example.org')
  })
})

/**
 * **The repeat is the useful thing**, and `#607` says so: *the rows are the
 * evidence; the useful thing is the repeat.*
 */
describe('seeing arrivals that came together', () => {
  it('gives arrivals sharing an origin the same letter, with a count', () => {
    const html = arrivalsSection(
      arrivals({
        agents: [
          anAgent({ name: 'one', originKey: 'together' }),
          anAgent({ name: 'two', originKey: 'together' }),
          anAgent({ name: 'three', originKey: 'apart' }),
        ],
      }),
    )

    expect(html).toContain('A <strong>×2</strong>')
    expect(html).toContain('>B<')
  })

  it('groups by operator and by mailbox domain on the same terms', () => {
    const html = arrivalsSection(
      arrivals({
        agents: [
          anAgent({ name: 'one', operated: true, operatorKey: 'op', operatorAgents: 2 }),
          anAgent({ name: 'two', operated: true, operatorKey: 'op', operatorAgents: 2 }),
        ],
      }),
    )

    expect(html).toContain('A <strong>×2</strong>')
    expect(html).toContain('holds 2')
  })

  /**
   * **The rejection case that matters most.** The origin fingerprint and the
   * operator's id are what makes the grouping answerable and are exactly the
   * values that must not be printed. They are turned into letters, so neither is
   * anywhere in the output.
   */
  it('prints no fingerprint, no operator id, and no address', () => {
    const html = arrivalsSection(
      arrivals({
        agents: [
          anAgent({
            originKey: 'a-fingerprint-value',
            operated: true,
            operatorKey: 'an-operator-id',
            mailboxDomain: 'example.org',
          }),
        ],
        people: [
          {
            registeredAt: '2026-08-08T00:00:00.000Z',
            provider: 'github',
            addressKnown: true,
            emailDomain: 'example.org',
            agentsOperated: 0,
            lastSeenAt: null,
          },
        ],
      }),
    )

    expect(html).not.toContain('a-fingerprint-value')
    expect(html).not.toContain('an-operator-id')
    // The domain is deliberately shown; nothing that names a person is.
    expect(html).toContain('example.org')
  })

  it('says what a letter is and is not, on the page', () => {
    const html = arrivalsSection(arrivals({ agents: [anAgent()] }))

    expect(html).toContain('A letter is a group, not an identity')
    expect(html).toContain('mean nothing between one reading and the next')
  })
})

/**
 * `#607`: *no score, no ranking, no automatic flag. The page shows facts and a
 * person draws the conclusion.*
 */
describe('what the section refuses to compute', () => {
  it('scores, ranks and flags nothing', () => {
    const html = arrivalsSection(
      arrivals({
        agents: [
          anAgent({ name: 'one', originKey: 'together' }),
          anAgent({ name: 'two', originKey: 'together' }),
        ],
      }),
    )

    /**
     * Scoped to the column headings, not the whole page: the section's own
     * sentence *says* nothing here is scored, flagged or ranked, so a needle
     * over the whole output matches the promise and fails on it.
     */
    const headings = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((match) =>
      (match[1] as string).toLowerCase(),
    )
    for (const word of ['suspicious', 'suspicion', 'risk', 'score', 'rank', 'flag']) {
      expect(headings.some((heading) => heading.includes(word))).toBe(false)
    }

    // And it says whose judgement it is instead.
    expect(html).toContain('Nothing here is scored, flagged or ranked')
    expect(html).toContain('it is yours')
  })

  it('adds no JavaScript', () => {
    const html = arrivalsSection(arrivals({ agents: [anAgent()] }))

    expect(html).not.toMatch(/<script\b/)
    expect(html).not.toMatch(/ on[a-z]+="/)
  })
})
