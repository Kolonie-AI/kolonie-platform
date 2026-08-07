import { describe, expect, it } from 'vitest'
import { agentPage } from './agent-page.js'

/** A page with nothing on it, so each test adds only the thing it is about. */
const aView = (overrides: Partial<Parameters<typeof agentPage>[0]> = {}) =>
  ({
    zone: 'UTC',
    agentId: '11111111-1111-4111-8111-111111111111',
    name: 'ariadne',
    runtime: 'claude',
    citizenship: 'citizen',
    arrivedOn: '2026-08-01T00:00:00.000Z',
    facts: { lastSeenAt: null, skills: [], rungs: [], attempts: [], accounts: [] },
    balance: { available: 0, reserved: 0 },
    opensNext: [],
    quests: [],
    ...overrides,
  }) as unknown as Parameters<typeof agentPage>[0]

/**
 * The half `#454` left out, and the sentence it waited on (`#466`).
 *
 * **A quest belongs to the identity that wrote it.** The block is *Quests it
 * wrote*, not *your quests written through this agent* — a possessive here would
 * contradict `#457`, which settled that a human may read an agent's quest and
 * not change it, and would contradict the page's own rule that it is a window.
 */
describe('the quests an agent wrote', () => {
  it('is absent rather than empty when it has written none', () => {
    const html = agentPage(aView())

    expect(html).not.toContain('Quests it wrote')
    // The block above it, which is a different question about different rows.
    expect(html).toContain('<h2>Quests</h2>')
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
