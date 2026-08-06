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

  /** The page's own rule, asserted so a later section cannot quietly drop it. */
  it('still says it is a window rather than a control panel', () => {
    expect(agentPage(aView())).toContain('a window rather than a control panel')
  })
})

/**
 * Where to send an operated agent money (`#470`).
 *
 * The balance block names depositing as the answer; before this the page showed
 * nowhere to deposit to, which made the sentence true and useless.
 */
describe('the agent’s deposit address', () => {
  const ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'

  it('shows the address under the balance, with the warnings above it', () => {
    const html = agentPage(aView({ depositAddress: ADDRESS }))

    expect(html).toContain(ADDRESS)
    expect(html).toContain('Send only USDC, on Solana')
    // Above rather than beside: a warning read after the decision is not a
    // warning. The heading order is the assertion.
    expect(html.indexOf('Send only USDC, on Solana')).toBeLessThan(html.indexOf(ADDRESS))
    // Under the balance, because the balance is what raises the question.
    expect(html.indexOf('<h2>Balance</h2>')).toBeLessThan(html.indexOf('Send only USDC, on Solana'))
  })

  it('carries the same warnings /funding does, from one renderer', () => {
    const html = agentPage(aView({ depositAddress: ADDRESS }))

    expect(html).toContain('Anything else sent to this address is lost.')
    expect(html).toContain('You are credited what arrives, not what you paid.')
    expect(html).toContain('Money in is one-way.')
    expect(html).toContain('One credit is one US cent.')
  })

  /**
   * The absent case is a sentence and never a button. Asking generates a
   * keypair, which is a step the agent takes — `#457` says the console does not
   * take it for them.
   */
  it('says the agent has not asked, and offers no way to ask for it', () => {
    const html = agentPage(aView())

    expect(html).toContain('has not asked for a deposit address')
    expect(html).toContain('POST /v1/deposits/address')
    // No form, no button, and no warnings — there is nothing to warn about yet.
    expect(html).not.toContain('deposits/address" method')
    expect(html).not.toContain('Send only USDC, on Solana')
  })

  it('points at the note section when there is one, and not when there is not', () => {
    expect(agentPage(aView({ operator: '<p>a form</p>' }))).toContain('href="#leave-a-note"')
    expect(agentPage(aView({ operator: '<p>a form</p>' }))).toContain('id="leave-a-note"')
    // No door, no link: `#428` decided that no live page means no door, and a
    // link to a section that is not rendered goes nowhere.
    expect(agentPage(aView())).not.toContain('href="#leave-a-note"')
  })

  /** `#457` unchanged: the operator reads the balance and cannot spend it. */
  it('does not turn the balance into something the operator can move', () => {
    const html = agentPage(aView({ depositAddress: ADDRESS }))

    expect(html).toContain('you can fund it and you cannot spend it')
    expect(html).toContain('a window rather than a control panel')
  })
})
