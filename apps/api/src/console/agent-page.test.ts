import { describe, expect, it } from 'vitest'
import { agentPage } from './agent-page.js'

/** A page with nothing on it, so each test adds only the thing it is about. */
const aView = (overrides: Partial<Parameters<typeof agentPage>[0]> = {}) =>
  ({
    nav: {},
    zone: 'UTC',
    agentId: '11111111-1111-4111-8111-111111111111',
    name: 'ariadne',
    runtime: 'claude',
    citizenship: 'citizen',
    arrivedOn: '2026-08-01T00:00:00.000Z',
    facts: { lastSeenAt: null, skills: [], rungs: [], attempts: [], accounts: [] },
    balance: { available: 0, reserved: 0 },
    walletAddress: null,
    opensNext: [],
    quests: [],
    accounts: { held: 0, planned: 0, wanted: 0 },
    autonomyHistory: [],
    ...overrides,
  }) as unknown as Parameters<typeof agentPage>[0]

describe('the autonomy contract', () => {
  it('offers the operator a route to record one without waiting for the agent', () => {
    const html = agentPage(aView())
    expect(html).toContain('No contract recorded yet')
    expect(html).toContain('/agents/11111111-1111-4111-8111-111111111111/autonomy')
  })

  it('keeps a superseded version readable with its own dates', () => {
    const html = agentPage(
      aView({
        autonomyHistory: [
          {
            level: 'accompanied',
            challengesAllowed: false,
            defaultRule: 'refrain',
            operatorRoute: 'Use the console.',
            recordedAt: '2026-08-10T10:00:00.000Z',
            reviewDueAt: '2027-08-10T10:00:00.000Z',
            supersededAt: null,
          },
          {
            level: 'free',
            challengesAllowed: true,
            defaultRule: 'ask',
            operatorRoute: 'Use mail.',
            recordedAt: '2026-08-09T10:00:00.000Z',
            reviewDueAt: '2027-08-09T10:00:00.000Z',
            supersededAt: '2026-08-10T10:00:00.000Z',
          },
        ],
      }),
    )

    expect(html).toContain('Current version')
    expect(html).toContain('Previous version 1')
    expect(html).toContain('Superseded')
    expect(html).toContain('Use mail.')
  })
})

/**
 * The half `#454` left out, and the sentence it waited on (`#466`).
 *
 * **A quest belongs to the identity that wrote it.** The block is *Quests it
 * wrote*, not *your quests written through this agent* — a possessive here would
 * contradict `#457`, which settled that a human may read an agent's quest and
 * not change it, and would contradict the page's own rule that it is a window.
 */
describe('the quests an agent wrote', () => {
  /**
   * **`#454`'s no-empty-heading rule was reversed by `#583`**, and the reason is
   * the contents list that issue added: an omitted section reads as *this agent
   * cannot do that*, and an entry marked empty reads as *nothing here yet*.
   * Only the second is true, so the section renders whatever its state and says
   * what would put a row in it.
   */
  it('renders with an empty state, and says whose decision fills it', () => {
    const html = agentPage(aView())

    expect(html).toContain('<h2 id="quests-it-wrote">Quests it wrote</h2>')
    expect(html).toContain('None written')
    // The block above it, which is a different question about different rows.
    expect(html).toContain('<h2 id="quests">Quests</h2>')
  })

  it('names them as the agent’s and points at where they overlap', () => {
    const html = agentPage(
      aView({
        questsWritten: [
          {
            questId: 'aaaaaaaa-1111-4111-8111-111111111111',
            title: 'A thousand mailboxes',
            status: 'active',
          },
        ],
      }),
    )

    expect(html).toContain('Quests it wrote')
    expect(html).toContain('A thousand mailboxes')
    // One quest in two places rather than two quests: the person's own list
    // carries the same row with this agent named in the author column.
    expect(html).toContain('also appear in')
    expect(html).toContain('href="/quests"')
    expect(html).toContain('you cannot')
    // Never a possessive. The page is a window.
    expect(html).not.toContain('Your quests written')
  })
})

/**
 * `#573`. A person who has paired with an agent, watched it clear the Academy
 * and now wants to fund it arrives here with a question this page could not
 * answer: **where do I send the SOL?**
 *
 * The block that briefly stood in this place asked the *person* to sign for the
 * agent (`#539`, reverted the same day). This one only reports a fact, which is
 * the whole difference: the key stays where it was generated.
 */
describe('where to send an agent SOL', () => {
  it('prints the proved address in full', () => {
    const html = agentPage(aView({ walletAddress: 'C8kdTzzyDXyPGjoNBefTZZ9KZt7feXAUQgY4vhuHVh1s' }))

    expect(html).toContain('<h2 id="wallet">Wallet</h2>')
    expect(html).toContain('C8kdTzzyDXyPGjoNBefTZZ9KZt7feXAUQgY4vhuHVh1s')
    // Whose key it is, said where the address is read rather than elsewhere.
    expect(html).toContain('Only the agent holds the key')
  })

  /**
   * **The empty state names whose step it is.** A person reading *no address*
   * with no explanation looks for a button — and there must never be one here,
   * because a person signing for an agent is exactly what `#539` got wrong.
   */
  it('says the rung is the agent’s own step when there is no address', () => {
    const html = agentPage(aView({ walletAddress: null }))

    expect(html).toContain('has not proved a wallet yet')
    expect(html).toContain('solana-wallet')
    expect(html).toContain('own step, not yours')
  })

  /**
   * Nothing in this block asks anybody to sign anything.
   *
   * Scoped to the block rather than the page: the layout's header carries a
   * *Sign out* button on every console page, and an assertion that failed on it
   * would be testing the furniture.
   */
  it('offers no way for a person to prove a wallet', () => {
    const html = agentPage(aView({ walletAddress: null }))
    const from = html.indexOf('<h2 id="wallet">Wallet</h2>')
    // `<h2` and not `<h2>`: every heading carries an id since `#583`, so the
    // old needle matched nothing and the "block" ran to the end of the page.
    const block = html.slice(from, html.indexOf('<h2', from + 1))

    expect(from).toBeGreaterThan(-1)
    expect(block).not.toMatch(/<button|<form|<input/i)
    expect(block).not.toMatch(/sign with|prove a wallet with/i)
    expect(block).not.toContain('href')
  })
})

/**
 * The contents column (`#583`).
 *
 * **The drift between the list and the sections is the thing that will happen**,
 * which is the definition of done's own wording — so it is asserted as a set
 * equality in both directions rather than by naming the sections here. A section
 * added without an entry, or an entry pointing at an id nothing renders, fails.
 */
describe('the contents list on the agent page', () => {
  const idsIn = (html: string, pattern: RegExp): string[] =>
    [...html.matchAll(pattern)].map((match) => match[1] as string)

  const rendered = (html: string): string[] => idsIn(html, /<h2 id="([^"]+)"/g)
  const listed = (html: string): string[] => {
    const start = html.indexOf('<nav class="page-contents"')
    const end = html.indexOf('</nav>', start)
    return idsIn(html.slice(start, end), /href="#([^"]+)"/g)
  }

  it('lists exactly the sections the page renders, in the same order', () => {
    const html = agentPage(
      aView({
        walletAddress: 'So11111111111111111111111111111111111111112',
        facts: {
          lastSeenAt: null,
          citizenSince: '2026-08-01T00:00:00.000Z',
          questsAccepted: 0,
          skills: ['mailbox'],
          rungs: [{ rung: 'a-rung', title: 'A rung', passedAt: '2026-08-01T00:00:00.000Z' }],
          attempts: [],
          accounts: [{ kind: 'mailbox', count: 1 }],
        },
        quests: [],
        questsWritten: [],
        accounts: { held: 1, planned: 0, wanted: 0 },
      }),
    )

    expect(listed(html)).toEqual(rendered(html))
  })

  /**
   * **The rejection case the definition of done asks for.** An agent with
   * nothing — no skills, no rungs, no quests, no accounts — still lists every
   * section, because a missing entry would say it cannot do those things.
   */
  it('lists every section for an agent that has done nothing at all', () => {
    const html = agentPage(aView())

    expect(listed(html)).toEqual([
      'wallet',
      'skills',
      'rungs-cleared',
      'recent-activity',
      'quests',
      'quests-it-wrote',
      'accounts',
      'autonomy-contract',
    ])
    expect(listed(html)).toEqual(rendered(html))
  })

  it('marks the empty ones as empty rather than hiding them', () => {
    const html = agentPage(aView())
    const start = html.indexOf('<nav class="page-contents"')
    const contents = html.slice(start, html.indexOf('</nav>', start))

    // Eight sections, eight marks: this agent has nothing anywhere.
    expect([...contents.matchAll(/\(empty\)/g)]).toHaveLength(8)
  })

  /**
   * The note is the one section that is conditional, and `#583`'s rule does not
   * cover it: an agent that has issued no operator page has no door (`#428`), so
   * *you cannot leave this agent a note* is the true reading rather than the
   * misleading one. Listing it would offer a form that is not there.
   */
  it('lists the note only when there is a door to it', () => {
    expect(listed(agentPage(aView()))).not.toContain('leave-a-note')
    expect(listed(agentPage(aView({ operator: '<p>the form</p>' })))).toContain('leave-a-note')
  })

  it('puts the whole page in one fetch, with nothing behind an interaction', () => {
    const html = agentPage(aView({ operator: '<p>the form</p>' }))

    expect(html).not.toMatch(/<script\b/)
    /**
     * Scoped to this page's own markup: `#608`'s navigation is a `<details>` per
     * section and is furniture on every console page. What `#583` refuses is a
     * disclosure around *this page's* content — no tabs, no accordion, nothing
     * a plain fetch cannot see.
     */
    const own = html.slice(html.indexOf('<div class="agent-page">'))
    expect(own).not.toMatch(/<details\b/)
    // Every anchor the list points at is an id in the same document.
    for (const id of listed(html)) expect(html).toContain(`id="${id}"`)
  })
})
