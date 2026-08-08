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
    walletAddress: null,
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

    expect(html).toContain('<h2>Wallet</h2>')
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
    const from = html.indexOf('<h2>Wallet</h2>')
    const block = html.slice(from, html.indexOf('<h2>', from + 1))

    expect(from).toBeGreaterThan(-1)
    expect(block).not.toMatch(/<button|<form|<input/i)
    expect(block).not.toMatch(/sign with|prove a wallet with/i)
    expect(block).not.toContain('href')
  })
})
