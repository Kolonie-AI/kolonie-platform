import { describe, expect, it } from 'vitest'
import { agentAccountsPage } from './agent-accounts.js'

const AGENT = '11111111-1111-4111-8111-111111111111'

/** A page with nothing on it, so each test adds only the thing it is about. */
const aPage = (overrides: Partial<Parameters<typeof agentAccountsPage>[0]> = {}) =>
  agentAccountsPage({
    nav: {},
    agentId: AGENT,
    name: 'ariadne',
    zone: 'UTC',
    held: [],
    wishes: [],
    ...overrides,
  } as unknown as Parameters<typeof agentAccountsPage>[0])

/**
 * What stopped answering, on the surface the operator actually reads (`#934`).
 *
 * A failed re-check reached the agent inside a wake-up digest and reached the
 * operator nowhere at all. These assert the half that was missing — and, as
 * firmly, that it says nothing when there is nothing to say.
 */
describe('the accounts that stopped answering', () => {
  const gone = {
    title: 'The mailbox at mail.example stopped answering',
    openedBy: 'colony',
    turn: 'agent',
    openedAt: '2026-08-01T00:00:00.000Z',
  } as const

  it('names the account, when it stopped and whose turn it is', () => {
    const html = aPage({ maintenance: [gone] })

    expect(html).toContain('What stopped answering')
    expect(html).toContain('The mailbox at mail.example stopped answering')
    expect(html).toContain('<td>ariadne’s</td>')
  })

  /**
   * The sentence that stops a row here reading as a punishment. Without it an
   * operator treats a lapsed account as an emergency, which is exactly the
   * conclusion `#152` decided the Colony would not invite.
   */
  it('says that nothing was taken away', () => {
    expect(aPage({ maintenance: [gone] })).toContain('Nothing has been taken away')
  })

  /**
   * **No heading when nothing is open.** A heading that says *nothing is wrong*
   * is one a reader learns to skip, and the one time it says something they will
   * have stopped looking.
   */
  it('renders no section at all when nothing is open', () => {
    expect(aPage()).not.toContain('What stopped answering')
    expect(aPage({ maintenance: [] })).not.toContain('What stopped answering')
  })

  /** `nobody` is a real answer, and it is not the agent's turn. */
  it('claims no turn on an episode nobody owes anything on', () => {
    const html = aPage({ maintenance: [{ ...gone, turn: 'nobody' }] })

    // The cell, not the page: the heading is the agent's name either way.
    expect(html).toContain('<td>nobody’s</td>')
    expect(html).not.toContain('<td>ariadne’s</td>')
  })
})
