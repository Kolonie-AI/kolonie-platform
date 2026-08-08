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
    dropId: null,
    ...over,
  })

  it('is absent entirely when nothing is waiting', () => {
    const html = dashboardPage({ zone: 'UTC', agents: [agent], waiting: [] })

    expect(html).not.toContain('Waiting on you')
  })

  it('names the agent, what was asked, and how long it has waited', () => {
    const html = dashboardPage({ zone: 'UTC', agents: [agent], waiting: [item()] })

    expect(html).toContain('Waiting on you (1)')
    expect(html).toContain('virio')
    expect(html).toContain('The six digits the provider just texted you.')
    expect(html).toContain('Prove you control a mailbox')
  })

  it('says that answering wakes the agent, and that this is not a control panel', () => {
    const html = dashboardPage({ zone: 'UTC', agents: [agent], waiting: [item()] })

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

  it('links a question to the page the operator holds, and a drop to nothing', () => {
    const html = dashboardPage({
      zone: 'UTC',
      agents: [agent],
      waiting: [
        item({ kind: 'code' }),
        item({ kind: 'question', ask: 'May I?', answerAt: '/operator/page/abc' }),
      ],
    })

    expect(html).toContain('href="/operator/page/abc"')
    // A drop's link is a bearer secret the Colony keeps only the hash of. A
    // sentence beats a dead link.
    expect(html).toContain('use the link that was mailed to you')
  })

  /**
   * The ordering is `inClearingOrder`'s and is asserted there. What is asserted
   * here is that the renderer does not re-sort — a second ordering in the page
   * would be a second answer to the question the page exists to answer.
   */
  it('draws the rows in the order it was given', () => {
    const html = dashboardPage({
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
