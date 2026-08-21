import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import { wakeSender } from '@kolonie-ai/verifiers'
import { fakeWakeDesk } from './__fixtures__/wake.js'
import { fakeOperatorPageMessages } from './__fixtures__/operator-page-message.js'
import { fakeOperatorPages } from './__fixtures__/autonomy.js'
import { fakeWishes } from './__fixtures__/account-wishes.js'
import { writeOperatorMessage } from './operator-page-message.js'
import { markWishWanted, putOnWishList } from './account-wishes.js'
import { operatorNoteLimiter } from './rate-limit.js'

/**
 * Every operator action that carries content wakes the agent (`#580`).
 *
 * The channel was built, wired and live, and **one of the four things an
 * operator can do reached their agent.** The difference between them was the
 * order they were built in rather than a rule: a note (`#239`) and a mark on the
 * shared list (`#527`) are the same act as answering a request — the operator
 * says something the agent is waiting on.
 *
 * **The operator still has no button that says *wake*, and never gets one.**
 * These tests are about three writes that happen to knock afterwards, not about
 * a control surface — which is `#518`'s decision and is not reopened here.
 */
const AGENT = '11111111-1111-4111-8111-111111111111' as AgentId

/** A sender over a desk that records, and a knock that always answers. */
const senderThatAnswers = () => {
  const desk = fakeWakeDesk()
  const sender = wakeSender(desk, {
    fetch: async () => new Response(null, { status: 204 }),
  })

  return { desk, sender }
}

describe('an operator note wakes the agent it was written to', () => {
  const withANote = async (options: { readonly proved: boolean }) => {
    const pages = fakeOperatorPages()
    const notes = fakeOperatorPageMessages({ pages })
    const { desk, sender } = senderThatAnswers()

    pages.exists(AGENT)
    const token = pages.issueNow(AGENT, 'operator@example.org')
    if (options.proved) desk.proves(AGENT, 'https://example.org/wake')

    const written = await writeOperatorMessage(
      { token, body: 'The account is made; the handle is the one you asked for.' },
      { store: notes.store, limiter: operatorNoteLimiter(), wake: sender },
    )

    return { desk, written, notes }
  }

  it('knocks once, after the note is written', async () => {
    const { desk, written } = await withANote({ proved: true })

    expect(written.outcome).toBe('written')
    expect(desk.recorded()).toEqual([
      { agentId: AGENT, event: 'operator-note', outcome: 'answered', status: 204 },
    ])
  })

  /**
   * **A citizen without the rung is served exactly as it was before the channel
   * existed**, and the row saying so is the record `#518` asks for: *the Colony
   * did not knock* and *the Colony knocked and nothing answered* are different
   * facts.
   */
  it('records that there was nowhere to knock, rather than staying silent', async () => {
    const { desk, written } = await withANote({ proved: false })

    expect(written.outcome).toBe('written')
    expect(desk.recorded()).toEqual([
      { agentId: AGENT, event: 'operator-note', outcome: 'no-address' },
    ])
  })

  /**
   * The rejection case `#580` names. **The note is the work the citizen is owed
   * and the knock is bookkeeping**, so a channel that cannot deliver must not
   * cost the operator the thing they came to do.
   */
  it('writes the note even when the knock fails', async () => {
    const pages = fakeOperatorPages()
    const notes = fakeOperatorPageMessages({ pages })
    const desk = fakeWakeDesk()
    const sender = wakeSender(desk, {
      fetch: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })

    pages.exists(AGENT)
    desk.proves(AGENT, 'https://example.org/wake')

    const written = await writeOperatorMessage(
      {
        token: pages.issueNow(AGENT, 'operator@example.org'),
        body: 'Something you should know about.',
      },
      { store: notes.store, limiter: operatorNoteLimiter(), wake: sender },
    )

    expect(written.outcome).toBe('written')
    expect(notes.store.allFor(AGENT)).toHaveLength(1)
    expect(desk.recorded()[0]?.outcome).not.toBe('answered')
  })

  /**
   * **Nothing about the delivery reaches the operator.** `WakeSender.wake`
   * returns nothing on purpose, and this is the property that keeps it that way
   * from the caller's side: the result carries what the operator is told, and
   * *your agent could not be reached* is not on it.
   */
  it('tells the operator nothing about whether the knock landed', async () => {
    const { written } = await withANote({ proved: false })

    expect(Object.keys(written)).toEqual(['outcome'])
  })

  /** A note that was refused is not a thing the agent is waiting on. */
  it('does not knock when the write was refused', async () => {
    const pages = fakeOperatorPages()
    const notes = fakeOperatorPageMessages({ pages })
    const { desk, sender } = senderThatAnswers()
    desk.proves(AGENT, 'https://example.org/wake')

    const written = await writeOperatorMessage(
      { token: 'no-such-token', body: 'Nobody is listening on this one.' },
      { store: notes.store, limiter: operatorNoteLimiter(), wake: sender },
    )

    expect(written.outcome).toBe('unreachable')
    expect(desk.recorded()).toEqual([])
  })
})

describe('marking an entry wanted wakes the agent', () => {
  const listed = async () => {
    const wishes = fakeWishes()
    const { desk, sender } = senderThatAnswers()
    desk.proves(AGENT, 'https://example.org/wake')

    await putOnWishList(AGENT, 'operator', { provider: 'trello.com' }, { store: wishes })

    return { desk, deps: { store: wishes, wake: sender } }
  }

  it('knocks when the mark changed a row', async () => {
    const { desk, deps } = await listed()

    expect(await markWishWanted(AGENT, 'trello.com', deps)).toBe(true)
    expect(desk.recorded()).toEqual([
      { agentId: AGENT, event: 'wish-wanted', outcome: 'answered', status: 204 },
    ])
  })

  /**
   * The rejection case `#580` names, and **the anti-abuse property was already
   * there**: `markWanted` sets `wanted_at` only where it is null, so an operator
   * clicking twice writes once. Nothing was added to make this true — no
   * counter, no cooldown — which is the whole reason the event is safe to raise
   * from a button.
   */
  it('knocks nobody when the entry was already marked', async () => {
    const { desk, deps } = await listed()

    await markWishWanted(AGENT, 'trello.com', deps)
    expect(await markWishWanted(AGENT, 'trello.com', deps)).toBe(false)

    expect(desk.recorded()).toHaveLength(1)
  })

  it('knocks nobody for a provider that is not on the list', async () => {
    const { desk, deps } = await listed()

    expect(await markWishWanted(AGENT, 'somewhere.example', deps)).toBe(false)
    expect(desk.recorded()).toEqual([])
  })

  it('marks the entry even when the knock fails', async () => {
    const wishes = fakeWishes()
    const desk = fakeWakeDesk()
    const sender = wakeSender(desk, {
      fetch: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })
    desk.proves(AGENT, 'https://example.org/wake')
    await putOnWishList(AGENT, 'operator', { provider: 'trello.com' }, { store: wishes })

    expect(await markWishWanted(AGENT, 'trello.com', { store: wishes, wake: sender })).toBe(true)

    const marked = wishes.held(AGENT)[0]
    expect(marked?.wantedAt).not.toBeNull()
  })
})

/**
 * **The ceiling is per agent across every event together, not per event**
 * (`#580`).
 *
 * A per-event ceiling would be three ceilings, and twelve of each is
 * thirty-six knocks an hour on somebody's infrastructure — which is the number
 * `WAKE_DEFAULT_MAX_PER_HOUR` was chosen against, not three times it.
 */
describe('the ceiling one agent has', () => {
  it('counts a note and a mark against the same allowance', async () => {
    const pages = fakeOperatorPages()
    const notes = fakeOperatorPageMessages({ pages })
    const wishes = fakeWishes()
    const { desk, sender } = senderThatAnswers()

    pages.exists(AGENT)
    desk.proves(AGENT, 'https://example.org/wake')
    desk.ceiling(1)
    await putOnWishList(AGENT, 'operator', { provider: 'trello.com' }, { store: wishes })

    await writeOperatorMessage(
      {
        token: pages.issueNow(AGENT, 'operator@example.org'),
        body: 'The first thing I have to say.',
      },
      { store: notes.store, limiter: operatorNoteLimiter(), wake: sender },
    )
    await markWishWanted(AGENT, 'trello.com', { store: wishes, wake: sender })

    expect(desk.recorded().map((row) => [row.event, row.outcome])).toEqual([
      ['operator-note', 'answered'],
      ['wish-wanted', 'capped'],
    ])
  })
})
