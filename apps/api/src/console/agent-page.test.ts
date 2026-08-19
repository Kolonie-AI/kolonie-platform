import { describe, expect, it } from 'vitest'
import type { ConversationId } from '@kolonie-ai/core'
import {
  agentPage,
  agentSectionPage,
  autonomyLines,
  emptyAgentPages,
  questsWrittenLines,
  rungsLines,
  walletLines,
} from './agent-page.js'
import { AGENT_PAGES, agentPagePath, consoleNavigation } from './navigation.js'
import { relative } from './time.js'

const AGENT = '11111111-1111-4111-8111-111111111111'

/** A page with nothing on it, so each test adds only the thing it is about. */
const aView = (overrides: Partial<Parameters<typeof agentPage>[0]> = {}) =>
  ({
    nav: {},
    zone: 'UTC',
    agentId: AGENT,
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
    threads: [],
    ...overrides,
  }) as unknown as Parameters<typeof agentPage>[0]

/** Every mark set, so a test naming one page names it deliberately. */
const NOTHING = {
  hasWallet: false,
  skills: 0,
  rungs: 0,
  attempts: 0,
  quests: 0,
  questsWritten: 0,
  accounts: 0,
  autonomyVersions: 0,
  threads: 0,
}

describe('the autonomy contract', () => {
  it('offers the operator a route to record one without waiting for the agent', () => {
    const html = agentPage(aView())
    expect(html).toContain('No contract recorded yet')
    expect(html).toContain(`/agents/${AGENT}/autonomy`)
  })

  it('keeps a superseded version readable with its own dates', () => {
    const html = autonomyLines(
      [
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
      'UTC',
    ).join('\n')

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
   * **`#454`'s no-empty-heading rule was reversed by `#583`**, and `#797` kept
   * the reversal when the sections became pages: an absent page reads as *this
   * agent cannot do that*, and a page marked empty reads as *nothing here yet*.
   * Only the second is true.
   */
  it('renders with an empty state, and says whose decision fills it', () => {
    expect(questsWrittenLines([]).join('\n')).toContain('None written')
    expect(questsWrittenLines(undefined).join('\n')).toContain('None written')
    // The page keeps its entry whatever is in it, and is marked instead.
    expect(emptyAgentPages(NOTHING)).toContain('quests-written')
  })

  it('names them as the agent’s and points at where they overlap', () => {
    const html = questsWrittenLines([
      {
        questId: 'aaaaaaaa-1111-4111-8111-111111111111',
        title: 'A thousand mailboxes',
        status: 'active',
      },
    ]).join('\n')

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
    const html = walletLines('C8kdTzzyDXyPGjoNBefTZZ9KZt7feXAUQgY4vhuHVh1s').join('\n')

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
    const html = walletLines(null).join('\n')

    expect(html).toContain('has not proved a wallet yet')
    expect(html).toContain('solana-wallet')
    expect(html).toContain('own step, not yours')
  })

  /**
   * Nothing in this section asks anybody to sign anything.
   *
   * **Asserted on the lines rather than on the rendered page** (`#797`). It used
   * to slice the page between two `<h2 id>`s, which is exactly the fragile thing
   * the anchors made necessary — and the page around them carries a *Sign out*
   * button that a page-wide assertion would have failed on. The section is its
   * own function now, so the scope is the function's return value.
   */
  it('offers no way for a person to prove a wallet', () => {
    const html = walletLines(null).join('\n')

    expect(html).not.toMatch(/<button|<form|<input/i)
    expect(html).not.toMatch(/sign with|prove a wallet with/i)
    expect(html).not.toContain('href')
  })
})

/**
 * What *empty* means, decided once (`#797`).
 *
 * The overview marks a line and the navigation marks an entry, and until this
 * they were two computations of one fact — which is D-002 in the small. Both
 * read this, so the test is of the definition rather than of either reader.
 */
describe('which of an agent’s pages have nothing on them', () => {
  it('marks every page an agent that has done nothing has not filled', () => {
    expect(emptyAgentPages(NOTHING)).toEqual([
      'wallet',
      'skills',
      'rungs',
      'activity',
      'quests',
      'quests-written',
      'accounts',
      'autonomy',
      'messages',
    ])
  })

  /**
   * The two that are never marked, and for different reasons: the overview is
   * the page the marks are drawn on, and the public profile exists whether or
   * not the agent has written one.
   */
  it('never marks the overview or the public profile', () => {
    const empty = emptyAgentPages(NOTHING)

    expect(empty).not.toContain('')
    expect(empty).not.toContain('profile')
  })

  it('marks nothing for an agent that has filled everything', () => {
    expect(
      emptyAgentPages({
        hasWallet: true,
        skills: 1,
        rungs: 1,
        attempts: 1,
        quests: 1,
        questsWritten: 1,
        accounts: 1,
        autonomyVersions: 1,
        threads: 1,
      }),
    ).toEqual([])
  })

  /** Every slug it can produce is a page in the table, or the nav would mark nothing. */
  it('names only slugs the navigation knows', () => {
    const slugs = new Set(AGENT_PAGES.map((entry) => entry.slug))
    for (const slug of emptyAgentPages(NOTHING)) expect(slugs).toContain(slug)
  })
})

/**
 * The navigation into an agent's pages (`#797`).
 *
 * This is the fix for the mobile regression: the contents column `#583` added
 * was displayed only from 75rem, so the one reader it was built for — somebody
 * on a phone with a long page to scroll — never saw it. The console's own
 * navigation is a `<details>` element and is shown at every width, which is why
 * the entries moved into it rather than into a second column.
 */
describe('an agent’s pages in the console navigation', () => {
  const inAgent = (empty: readonly string[] = [], current = agentPagePath(AGENT, '')) =>
    consoleNavigation({ current, agent: { agentId: AGENT, name: 'ariadne', empty } })

  const hrefs = (html: string): string[] =>
    [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1] as string)

  it('lists every one of that agent’s pages, titled with its name', () => {
    const html = inAgent()

    expect(html).toContain('ariadne')
    for (const entry of AGENT_PAGES) {
      expect(hrefs(html)).toContain(agentPagePath(AGENT, entry.slug))
      expect(html).toContain(entry.title)
    }
  })

  /**
   * **The criterion, stated as the assertion.** A `#fragment` in the navigation
   * would be an entry `aria-current` can never land on, which is what the old
   * contents column was made of.
   */
  it('carries no fragment as a destination', () => {
    for (const href of hrefs(inAgent())) expect(href).not.toContain('#')
  })

  it('marks where you are, on exactly one entry, on every one of them', () => {
    for (const entry of AGENT_PAGES) {
      const html = inAgent([], agentPagePath(AGENT, entry.slug))
      expect([...html.matchAll(/aria-current="page"/g)]).toHaveLength(1)
    }
  })

  /**
   * `#583`'s rule, carried over: *`empty` is a fact about this agent, not about
   * the section*. A missing entry says the agent cannot do the thing; an entry
   * marked empty says nothing has happened yet.
   */
  it('keeps the empty pages and marks them', () => {
    const html = inAgent(emptyAgentPages(NOTHING))

    expect([...html.matchAll(/\(empty\)/g)]).toHaveLength(9)
    for (const entry of AGENT_PAGES) {
      expect(hrefs(html)).toContain(agentPagePath(AGENT, entry.slug))
    }
  })

  /**
   * **The current agent only.** *All agents* is above it and is how somebody
   * reaches a different one; a navigation listing every agent's eleven pages would
   * be the long page again, in a column.
   */
  it('is absent everywhere outside an agent', () => {
    const html = consoleNavigation({ current: '/quests' })

    expect(html).not.toContain('ariadne')
    for (const href of hrefs(html)) expect(href).not.toContain('/agents/')
  })
})

/**
 * One section, on a page of its own (`#797`).
 */
describe('a section page', () => {
  const rendered = agentSectionPage({
    nav: { current: agentPagePath(AGENT, 'rungs'), agent: { agentId: AGENT, name: 'ariadne' } },
    agentId: AGENT,
    name: 'ariadne',
    title: 'Rungs cleared',
    lines: rungsLines([{ rung: 'a-rung', title: 'A rung', passedAt: '2026-08-01T00:00:00.000Z' }]),
  })

  it('is titled with the section and carries only that section', () => {
    expect(rendered).toContain('<h1>Rungs cleared</h1>')
    expect(rendered).toContain('A rung')
    // Not the whole page in disguise: no other section's content came with it.
    expect(rendered).not.toContain('has not proved a wallet yet')
    expect(rendered).not.toContain('No contract recorded yet')
  })

  it('leads back to the agent it belongs to', () => {
    expect(rendered).toContain(`href="${agentPagePath(AGENT, '')}"`)
    expect(rendered).toContain('Back to ariadne')
  })

  /** No second menu on the page — the column to the left is the only one. */
  it('draws no contents list of its own', () => {
    expect(rendered).not.toContain('page-contents')
    expect(rendered).not.toMatch(/href="#/)
  })
})

/**
 * The overview (`#798`), which is what `/agents/:agentId` is now (`#797`).
 *
 * **A reader should be able to answer *how is this agent doing* without opening
 * anything.** That is the whole test: one line per page whatever the agent's
 * state, each carrying a figure or a phrase rather than the page itself, and
 * every figure the same read as the page it points at.
 */
describe('the overview on the agent page', () => {
  const overview = (html: string): string => {
    const start = html.indexOf('<ul class="page-overview">')
    return html.slice(start, html.indexOf('</ul>', start))
  }

  const lines = (html: string): string[] =>
    [...overview(html).matchAll(/<li>(.*?)<\/li>/g)].map((match) => match[1] as string)

  /**
   * **The rejection case the definition of done asks for.** An agent with
   * nothing renders ten lines saying so — `#583`'s rule, which this page
   * cannot break: a missing entry reads as *this agent cannot do that*, and an
   * entry marked empty reads as *nothing here yet*.
   */
  it('gives an agent that has done nothing ten lines saying so', () => {
    const html = agentPage(aView())
    const ten = lines(html)

    expect(ten).toHaveLength(10)
    expect(overview(html)).toContain('No wallet proved yet')
    expect(overview(html)).toContain('None held yet')
    expect(overview(html)).toContain('None cleared yet')
    expect(overview(html)).toContain('Nothing attempted yet')
    expect(overview(html)).toContain('None taken yet')
    expect(overview(html)).toContain('None written')
    expect(overview(html)).toContain('Nothing proved yet')
    expect(overview(html)).toContain('No contract recorded yet')
    expect(overview(html)).toContain('Nothing said yet')
    // The one line that says nothing is missing: the page exists either way.
    expect(overview(html)).toContain('asking for this agent by name')
  })

  /**
   * **Every line leads to a page, and none of them to a fragment** (`#797`).
   *
   * Six of these were `#anchor`s into a page that rendered all nine sections at
   * once. Two were already pages of their own, which is what settled the
   * direction: the sections became pages rather than the pages becoming
   * sections.
   */
  it('leads each line to the page that holds it', () => {
    const html = agentPage(aView())
    const targets = [...overview(html).matchAll(/href="([^"]+)"/g)].map((match) => match[1])

    expect(targets).toEqual([
      `/agents/${AGENT}/wallet`,
      `/agents/${AGENT}/skills`,
      `/agents/${AGENT}/rungs`,
      `/agents/${AGENT}/activity`,
      `/agents/${AGENT}/quests`,
      `/agents/${AGENT}/quests-written`,
      `/agents/${AGENT}/accounts`,
      `/agents/${AGENT}/autonomy`,
      `/agents/${AGENT}/messages`,
      `/agents/${AGENT}/profile`,
    ])
    for (const target of targets) expect(target).not.toContain('#')
  })

  /**
   * **The line and the page it points at are one read of one fact.** Not a
   * second query answering the same question in a different shape, which is the
   * acceptance criterion — so the count on the line is asserted against the rows
   * the section's own renderer produces rather than against the input twice.
   */
  it('states a figure the page it points at agrees with', () => {
    const rungs = [
      { rung: 'a-rung', title: 'A rung', passedAt: '2026-08-01T00:00:00.000Z' },
      { rung: 'b-rung', title: 'B rung', passedAt: '2026-08-03T00:00:00.000Z' },
      { rung: 'c-rung', title: 'C rung', passedAt: '2026-08-02T00:00:00.000Z' },
    ]

    const html = agentPage(
      aView({
        facts: {
          lastSeenAt: null,
          citizenSince: '2026-08-01T00:00:00.000Z',
          questsAccepted: 0,
          skills: ['mailbox', 'browser'],
          rungs,
          attempts: [],
          accounts: [],
        },
        accounts: { held: 4, planned: 2, wanted: 1 },
      }),
    )

    expect(overview(html)).toContain('3 cleared')
    expect([
      ...rungsLines(rungs)
        .join('\n')
        .matchAll(/<tr><td>/g),
    ]).toHaveLength(3)
    // And the accounts line carries the counts `/agents/:agentId/accounts` was
    // given, in the same read that produced the page's own sentence.
    expect(overview(html)).toContain(
      '4 proved, 2 on the list you keep together, 1 marked as wanted',
    )
  })

  it('says nothing is proved and nothing planned, in that order, for a new agent', () => {
    expect(overview(agentPage(aView()))).toContain(
      'Nothing proved yet, nothing on the list you keep together.',
    )
  })

  /**
   * `AGENTS.md` §7: a figure that carries a moment keeps it. The rungs render
   * oldest first and the pulse newest first, so *the last one* is the newest
   * moment in the set rather than an end of an array — a page that changed the
   * order it prints in must not make this line start lying.
   */
  it('dates the last rung by its moment and not by its place in the table', () => {
    const html = agentPage(
      aView({
        facts: {
          lastSeenAt: null,
          citizenSince: '2026-08-01T00:00:00.000Z',
          questsAccepted: 0,
          skills: [],
          rungs: [
            { rung: 'newest', title: 'Newest', passedAt: '2026-08-12T00:00:00.000Z' },
            { rung: 'oldest', title: 'Oldest', passedAt: '2020-01-01T00:00:00.000Z' },
          ],
          attempts: [],
          accounts: [],
        },
      }),
    )

    // The newest of the two, which is the first in the array here and the last
    // in the table the rungs page renders.
    expect(overview(html)).toContain(`2 cleared, the last ${relative('2026-08-12T00:00:00.000Z')}`)
    expect(overview(html)).not.toContain(relative('2020-01-01T00:00:00.000Z'))
  })

  /**
   * The overview carries no section's content — which since `#797` is the whole
   * of what this page is, rather than a rule about one list on it.
   */
  it('carries no rows of its own, and neither does the page around it', () => {
    const html = agentPage(
      aView({
        walletAddress: 'C8kdTzzyDXyPGjoNBefTZZ9KZt7feXAUQgY4vhuHVh1s',
        quests: [
          {
            questId: 'aaaaaaaa-1111-4111-8111-111111111111',
            title: 'A thousand mailboxes',
            at: '2026-08-10T00:00:00.000Z',
            outcome: 'accepted',
          },
        ],
      }),
    )

    expect(overview(html)).not.toMatch(/<table|<tr|<h2/)
    expect(overview(html)).toContain('1 taken, the last')
    // The address is on the wallet page and on neither the line nor this one.
    expect(html).not.toContain('C8kdTzzyDXyPGjoNBefTZZ9KZt7feXAUQgY4vhuHVh1s')
    expect(html).not.toContain('A thousand mailboxes')
  })

  /**
   * **One fetch, nothing behind an interaction**, and no second menu (`#797`).
   *
   * The `<details>` assertion is scoped away from `#608`'s navigation, which is
   * furniture on every console page. What is asserted here is that this page's
   * own body has no disclosure and no contents column.
   */
  it('draws one menu and puts the whole page in one fetch', () => {
    const html = agentPage(aView({ hasDoor: true }))

    expect(html).not.toMatch(/<script\b/)
    expect(html).not.toContain('page-contents')
    const body = html.slice(html.indexOf('<ul class="page-overview">'))
    expect(body).not.toMatch(/<details\b/)
  })

  it('adds a line for the door only when there is one to leave a note at', () => {
    expect(lines(agentPage(aView()))).toHaveLength(10)

    const withDoor = lines(agentPage(aView({ hasDoor: true })))
    expect(withDoor).toHaveLength(11)
    expect(withDoor[10]).toContain('A door is open')
    expect(withDoor[10]).toContain(`/agents/${AGENT}/operator`)
  })

  /**
   * **The messages line counts what is waiting, not what was said** (`#1305`).
   *
   * The entry is in `AGENT_PAGES` and the operator door is not, and the
   * difference is what each varies with: this page exists for every agent and
   * is empty until somebody writes, which is the case `#583` says to mark.
   */
  it('says how many threads there are and how many are unread', () => {
    const withThreads = lines(
      agentPage(
        aView({
          threads: [
            {
              id: '22222222-2222-4222-8222-222222222222' as ConversationId,
              kind: 'operator-human',
              participants: [],
              createdAt: '2026-08-01T00:00:00.000Z',
              lastMessageAt: '2026-08-02T00:00:00.000Z',
              unread: 2,
            },
          ],
        }),
      ),
    )

    expect(withThreads[8]).toContain('1 thread')
    expect(withThreads[8]).toContain('2 unread')
    expect(withThreads[8]).toContain(`/agents/${AGENT}/messages`)
    expect(withThreads[8]).not.toContain('(empty)')
  })
})
