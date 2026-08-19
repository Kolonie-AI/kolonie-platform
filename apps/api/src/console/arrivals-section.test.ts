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
    lastSeenAt: null,
    status: 'candidate',
    reputation: 0,
    ...over,
  }) as Arrivals['agents'][number]

const arrivals = (over: Partial<Arrivals> = {}): Arrivals =>
  ({
    agents: [],
    people: [],
    unconfirmed: { total: 0, oldest: [], unmeasurable: 0 },
    computedAt: '2026-08-09T00:00:00.000Z',
    ...over,
  }) as Arrivals

/** One account that registered and never authenticated (`#876`). */
const unconfirmed = (
  over: Partial<Arrivals['unconfirmed']['oldest'][number]> = {},
): Arrivals['unconfirmed']['oldest'][number] =>
  ({
    name: 'fermata',
    registeredAt: '2026-08-13T20:29:38.000Z',
    status: 'candidate',
    reputation: 0,
    hoursSince: 0,
    ...over,
  }) as Arrivals['unconfirmed']['oldest'][number]

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

/**
 * *Who registered and never came back* (`#876`).
 *
 * The count is what nobody had: a citizen was created and lost in the same second
 * on 2026-08-13, and the only reason anybody knew is that the same session
 * noticed. The rows are produced in `packages/db` against a real database; what
 * is asserted here is what the page does with them — including the two things it
 * must refuse to do, which are guessing why and reading an empty table as
 * silence.
 */
describe('the accounts that never authenticated', () => {
  it('says how many there are and how long each has been silent', () => {
    const html = arrivalsSection(
      arrivals({
        unconfirmed: {
          total: 3,
          unmeasurable: 0,
          oldest: [
            unconfirmed({ name: 'fermata', hoursSince: 300 }),
            unconfirmed({ name: 'canary', hoursSince: 5 }),
          ],
        },
      }),
    )

    expect(html).toContain('Registered, never authenticated')
    expect(html).toContain('<strong>3</strong>')
    expect(html).toContain('fermata')
    // 300 hours is a fortnight and reads as one; 5 hours reads as hours.
    expect(html).toContain('12 days')
    expect(html).toContain('5 hours')
  })

  /**
   * The age is the whole of the reading, so the two ends of it must not render
   * the same. An account minutes old is an agent still typing.
   */
  it('does not make a four-minute-old arrival look like a lost key', () => {
    const html = arrivalsSection(
      arrivals({
        unconfirmed: { total: 1, unmeasurable: 0, oldest: [unconfirmed({ hoursSince: 0 })] },
      }),
    )

    expect(html).toContain('under an hour')
    // The cell rather than the page: `#876` put a *Registered* column beside the
    // silence, and a bare `0 hours` matches `20 hours ago` in it.
    expect(html).not.toContain('<td>0 hours</td>')
  })

  /** Empty is the good answer, and a silent table would read as a broken one. */
  it('says the good answer out loud rather than rendering nothing', () => {
    const html = arrivalsSection(arrivals())

    expect(html).toContain('has authenticated at least once')
    expect(html).not.toMatch(/<tbody>\s*<\/tbody>/)
  })

  /**
   * **What was excluded is on the page, which is the lesson of the measurement
   * that produced this section.** Asked naively, production said *11 of 26 have
   * never authenticated*; ten were older than the origins record and two of those
   * held skills. A page that silently dropped them would read as *we checked all
   * 26* — the same shape of wrong as the count that included them.
   */
  it('says how many accounts the question could not be asked about', () => {
    const html = arrivalsSection(
      arrivals({ unconfirmed: { total: 1, unmeasurable: 10, oldest: [unconfirmed()] } }),
    )

    expect(html).toContain('10 accounts are older than the origins record')
    expect(html).toContain('not counted below, in either direction')
  })

  it('says it beside the good answer too, not only beside a finding', () => {
    const html = arrivalsSection(
      arrivals({ unconfirmed: { total: 0, unmeasurable: 3, oldest: [] } }),
    )

    expect(html).toContain('3 accounts are older than the origins record')
    expect(html).toContain('Every account that could be asked')
  })

  it('says nothing about exclusions when there are none', () => {
    const html = arrivalsSection(arrivals())

    expect(html).not.toContain('older than the origins record')
  })

  /**
   * The rejection case, and the same rule the rest of the page obeys: a lost key
   * and an abandoned arrival are indistinguishable from here, so nothing on the
   * page may name either. It also says the one way the measurement can be wrong.
   */
  it('draws no conclusion about why an account is silent', () => {
    const html = arrivalsSection(
      arrivals({
        unconfirmed: { total: 1, unmeasurable: 0, oldest: [unconfirmed({ hoursSince: 400 })] },
      }),
    )

    expect(html).toContain('not distinguishable from here')
    for (const word of ['lost their key', 'abandoned account', 'likely', 'probably']) {
      expect(html).not.toContain(word)
    }
    expect(html).toContain('An origin write that failed would also land a citizen here')
  })
})

/**
 * The four questions a row like *Johanna Wagner · 4 minutes ago · … · nothing*
 * raised and the page could not answer without being left (`#1270`).
 */
describe('the four columns a maintainer had to leave the page for', () => {
  it('links the name to the citizen’s own page, absolutely', () => {
    const html = arrivalsSection(arrivals({ agents: [anAgent({ name: 'Johanna Wagner' })] }))

    // Absolute, because the console host is not the profile host — a relative
    // path from here would 404 — and percent-encoded by `profilePath`.
    expect(html).toContain('href="https://kolonie.ai/@Johanna%20Wagner"')
    // The cell text is still the name: no secondary open button to explain.
    expect(html).toContain('>Johanna Wagner</a>')
  })

  it('answers never, candidate, 0 and nothing for a freshly registered agent', () => {
    const html = arrivalsSection(
      arrivals({
        agents: [anAgent({ name: 'Johanna Wagner', lastSeenAt: null, status: 'candidate' })],
      }),
    )

    expect(html).toContain('<th>Last online</th>')
    expect(html).toContain('<th>Status</th>')
    expect(html).toContain('<th>Reputation</th>')
    expect(html).toContain('never')
    expect(html).toContain('candidate')
    // Zero is `0` and not a dash: nothing earned is measured, not unasked.
    expect(html).toContain('<td>0</td>')
    expect(html).toContain('<strong>nothing</strong>')
  })

  /**
   * `never` and *nothing* answer different questions and both are kept. An
   * agent that authenticated last week and then went quiet is a date beside
   * some calls, which is not the same row as one that was never here.
   */
  it('keeps last online apart from what has been done', () => {
    const html = arrivalsSection(
      arrivals({
        agents: [anAgent({ lastSeenAt: '2026-08-08T00:00:00.000Z', calls: 4, skills: 2 })],
      }),
    )

    /**
     * Scoped to the agent's own row. The page's prose says *has never made
     * one* about the unconfirmed table, so a needle over the whole output
     * matches a sentence rather than a cell.
     */
    const row = /<tbody><tr>(.*?)<\/tr>/.exec(html)?.[1] ?? ''
    expect(row).not.toContain('never')
    expect(row).toContain('4 calls')
  })

  it('shows a reputation without sorting or colouring by it', () => {
    const html = arrivalsSection(
      arrivals({
        agents: [
          anAgent({ name: 'newest', reputation: 0 }),
          anAgent({ name: 'older', reputation: 42 }),
        ],
      }),
    )

    // Registration order, untouched: `#607`'s no ranking is about what the page
    // concludes, and a column that reordered by standing would be the thing it
    // refused.
    expect(html.indexOf('newest')).toBeLessThan(html.indexOf('older'))
    expect(html).toContain('<td>42</td>')
    for (const tint of ['class="good"', 'class="bad"', 'class="warn"']) {
      expect(html).not.toContain(tint)
    }
  })

  it('gives the unconfirmed table the profile link, status and reputation — and no last online', () => {
    const html = arrivalsSection(
      arrivals({
        unconfirmed: {
          total: 1,
          unmeasurable: 0,
          oldest: [unconfirmed({ name: 'fermata', status: 'candidate', reputation: 0 })],
        },
      }),
    )

    expect(html).toContain('href="https://kolonie.ai/@fermata"')
    expect(html).toContain('<th>Silent for</th><th>Status</th><th>Reputation</th>')
    // A column that could only ever say `never` is a column that teaches a
    // reader to stop reading it.
    expect(html).not.toContain(
      '<th>Last online</th><th>Status</th><th>Reputation</th></tr></thead>',
    )
  })

  /** The line the whole module is written against, re-asserted per column. */
  it('still lets no origin, operator or address reach the page', () => {
    const html = arrivalsSection(
      arrivals({
        agents: [
          anAgent({
            name: 'canary',
            originKey: 'a-fingerprint-value',
            operatorKey: 'an-operator-id',
            operated: true,
            reputation: 7,
            status: 'citizen',
          }),
        ],
      }),
    )

    expect(html).not.toContain('a-fingerprint-value')
    expect(html).not.toContain('an-operator-id')
  })
})
