import { describe, expect, it } from 'vitest'
import type { WaitingItem } from '@kolonie-ai/core'
import { dashboardPage } from './html.js'

/**
 * The queue on the fleet page (#530).
 *
 * **The two behaviours worth a test are the two the issue names as failures.**
 * A heading over an empty table teaches a person the page usually has nothing on
 * it, and a page that reads as a control panel is the thing `#512` refuses and
 * this inherits.
 */
describe('the operator queue on the fleet page', () => {
  const agent = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'virio',
    citizenship: 'citizen',
    skillsHeld: 4,
    lastSeenAt: null,
  }

  const item = (over: Partial<WaitingItem> = {}): WaitingItem => ({
    agentId: agent.id,
    agentName: agent.name,
    kind: 'code',
    ask: 'The six digits the provider just texted you.',
    about: 'Prove you control a mailbox',
    since: '2026-08-08T08:00:00.000Z',
    answerAt: null,
    requestId: null,
    dropId: null,
    shareId: null,
    expiresAt: null,
    ...over,
  })

  it('is absent entirely when nothing is waiting', () => {
    const html = dashboardPage({ nav: {}, zone: 'UTC', agents: [agent], waiting: [] })

    expect(html).not.toContain('Waiting on you')
  })

  it('names the agent, what was asked, and how long it has waited', () => {
    const html = dashboardPage({ nav: {}, zone: 'UTC', agents: [agent], waiting: [item()] })

    expect(html).toContain('Waiting on you (1)')
    expect(html).toContain('virio')
    expect(html).toContain('The six digits the provider just texted you.')
    expect(html).toContain('Prove you control a mailbox')
  })

  it('says that answering wakes the agent, and that this is not a control panel', () => {
    const html = dashboardPage({ nav: {}, zone: 'UTC', agents: [agent], waiting: [item()] })

    expect(html).toContain('Answering wakes the agent')
    expect(html).toContain('Nothing here starts, stops or instructs an agent')
  })

  /**
   * `#570`. The queue listed a drop and then sent the operator to their inbox
   * for a three-day-old mail, which is the item they do later or not at all —
   * and `code` is first in the ordering precisely because the value is already
   * on a screen in front of them.
   */
  describe('a drop, which the queue could name and not clear', () => {
    const withDrop = () =>
      dashboardPage({
        nav: {},
        zone: 'UTC',
        agents: [agent],
        waiting: [item({ kind: 'code', dropId: '22222222-2222-4222-8222-222222222222' })],
      })

    it('offers the field itself, posting the row id and not a link', () => {
      const html = withDrop()

      expect(html).toContain('action="/drops/22222222-2222-4222-8222-222222222222"')
      expect(html).toContain('name="value"')
      // The mailed link is still never reproduced, and the sentence that stood
      // in for it is gone from this row.
      expect(html).not.toContain('use the link that was mailed to you')
    })

    it('does not leave the value legible on a shared screen', () => {
      expect(withDrop()).toContain('type="password"')
    })
  })

  /**
   * **The console links to its own door and never reproduces the token**
   * (`#587`).
   *
   * The row still carries `answerAt` — it is correct for the mailed digest,
   * where the token *is* how the operator is known — and this asserts the
   * console *substitutes* rather than that the field went away. A test built on
   * a row with no `answerAt` would pass against a console that had simply
   * stopped rendering a link at all.
   *
   * The fragment is `#593`'s anchor, so the reader lands on the question they
   * clicked rather than at the top of a page whose first blocks are about
   * identity.
   */
  it('links a question to the console’s own door, carrying no token', () => {
    const html = dashboardPage({
      nav: {},
      zone: 'UTC',
      agents: [agent],
      waiting: [
        item({ kind: 'code' }),
        item({
          kind: 'question',
          ask: 'May I?',
          answerAt: '/operator/page/abc',
          requestId: '22222222-2222-4222-8222-222222222222',
        }),
      ],
    })

    expect(html).toContain(
      `href="/agents/${agent.id}/operator#question-22222222-2222-4222-8222-222222222222"`,
    )
    expect(html).not.toContain('/operator/page/abc')
    // A drop's link is a bearer secret the Colony keeps only the hash of. A
    // sentence beats a dead link.
    expect(html).toContain('use the link that was mailed to you')
  })

  /** A question with no id lands on the door itself rather than on a dead fragment. */
  it('links to the door with no fragment when the row names no exchange', () => {
    const html = dashboardPage({
      nav: {},
      zone: 'UTC',
      agents: [agent],
      waiting: [item({ kind: 'question', answerAt: '/operator/page/abc', requestId: null })],
    })

    expect(html).toContain(`href="/agents/${agent.id}/operator"`)
    expect(html).not.toContain('/operator/page/abc')
  })

  /**
   * A live tab (`#738`).
   *
   * The row has to answer two things no other kind does: how long the offer has
   * left, and whether it is still worth clicking. The second is the one the issue
   * names as a failure — *"an expired item is visibly expired in the list rather
   * than on the click"* — because a link that dies on the click is how a person
   * concludes the console is broken.
   */
  describe('a share, which is the only item with a deadline', () => {
    const shareId = '33333333-3333-4333-8333-333333333333'
    const withShare = (expiresAt: string) =>
      dashboardPage({
        nav: {},
        zone: 'UTC',
        agents: [agent],
        waiting: [
          item({
            kind: 'browser-share',
            ask: 'The signup page wants a picture puzzle solved.',
            about: 'mail.tm, step 3',
            shareId,
            expiresAt,
          }),
        ],
      })

    /** Far enough out that the page is the same on any day this test runs. */
    const live = () => new Date(Date.now() + 3_600_000).toISOString()

    it('opens the window, and says what the item costs to clear', () => {
      const html = withShare(live())

      expect(html).toContain(`href="/browser/share/${shareId}"`)
      expect(html).toContain('a live tab')
      // Not a form. Nothing is submitted from this row — the socket is the
      // whole of the interaction, and it proves itself against the session.
      expect(html).not.toContain(`action="/browser/share/${shareId}"`)
    })

    it('shows how long the offer has left, beside how long it has waited', () => {
      expect(withShare(live())).toContain('lapses')
    })

    it('replaces the link with the word once the offer has lapsed', () => {
      const html = withShare('2026-01-01T00:00:00.000Z')

      expect(html).toContain('expired — the agent has to offer again')
      expect(html).not.toContain(`href="/browser/share/${shareId}"`)
    })
  })

  /**
   * The ordering is `inClearingOrder`'s and is asserted there. What is asserted
   * here is that the renderer does not re-sort — a second ordering in the page
   * would be a second answer to the question the page exists to answer.
   */
  it('draws the rows in the order it was given', () => {
    const html = dashboardPage({
      nav: {},
      zone: 'UTC',
      agents: [agent],
      waiting: [
        item({ kind: 'question', ask: 'first as given' }),
        item({ kind: 'code', ask: 'second as given' }),
      ],
    })

    expect(html.indexOf('first as given')).toBeLessThan(html.indexOf('second as given'))
  })
})
