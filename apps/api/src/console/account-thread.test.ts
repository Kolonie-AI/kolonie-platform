import { describe, expect, it } from 'vitest'
import {
  accountThreadPage,
  statusLine,
  type Conversation,
  type ConversationSlot,
} from './account-thread.js'
import type { HeldAccountRow } from './agent-accounts.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const ACCOUNT = '22222222-2222-4222-8222-222222222222'

/** RFC 2606 throughout: `AGENTS.md` §3 keeps real hostnames out of the repo. */
const anAccount = (overrides: Partial<HeldAccountRow> = {}): HeldAccountRow => ({
  id: ACCOUNT,
  kind: 'mailbox',
  provider: 'mail.example',
  identifier: 'ariadne@mail.example',
  status: 'in-use',
  proved: true,
  confirmedAt: null,
  unconfirmedSince: null,
  ...overrides,
})

const aSlot = (overrides: Partial<ConversationSlot> = {}): ConversationSlot => ({
  id: '44444444-4444-4444-8444-444444444444',
  label: 'password',
  secret: false,
  awaits: 'agent',
  filled: true,
  value: 'not-a-secret',
  readsLeft: 3,
  gone: false,
  ...overrides,
})

const aConversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Something is wrong with the mailbox at mail.example',
  openedBy: 'operator',
  turn: 'agent',
  outcome: null,
  wall: null,
  openedAt: '2026-08-14T00:00:00.000Z',
  closedAt: null,
  entries: [],
  slots: [],
  ...overrides,
})

const aPage = (overrides: Partial<Parameters<typeof accountThreadPage>[0]> = {}) =>
  accountThreadPage({
    nav: {},
    agentId: AGENT,
    name: 'ariadne',
    zone: 'UTC',
    account: anAccount(),
    conversations: [],
    ...overrides,
  } as unknown as Parameters<typeof accountThreadPage>[0])

/**
 * One account, and everything either side has ever said about it (`#932`).
 *
 * The list `#928` built stops where an operator's next question starts. These
 * assert the four things the issue names: the head, the derived status, the
 * thread itself, and — as firmly as any of them — that a secret's value is not
 * on the page under any arrangement of the flags.
 */
describe('the account is the page', () => {
  it('names the account, its kind and its provider', () => {
    const html = aPage()

    expect(html).toContain('ariadne@mail.example')
    expect(html).toContain('mailbox')
    expect(html).toContain('mail.example')
  })

  /**
   * *Nobody is waiting* is the common answer and has to be sayable plainly: an
   * operator who cannot tell *nothing is owed* from *I have not been told*
   * checks the page daily and learns nothing from it.
   */
  it('says nobody is waiting when nothing is open', () => {
    expect(statusLine([], 'ariadne')).toContain('Nobody is waiting')
    expect(
      statusLine([aConversation({ outcome: 'repaired', turn: 'nobody' })], 'ariadne'),
    ).toContain('Nobody is waiting')
  })

  it('says who is waiting, in the second person for the reader', () => {
    expect(statusLine([aConversation({ turn: 'operator' })], 'ariadne')).toContain('Waiting on you')
    expect(statusLine([aConversation({ turn: 'agent' })], 'ariadne')).toContain(
      'Waiting on ariadne',
    )
  })

  /** Counts, with `nobody` one of the three rather than the remainder. */
  it('counts the open conversations when there is more than one', () => {
    const line = statusLine(
      [
        aConversation({ id: 'a', turn: 'operator' }),
        aConversation({ id: 'b', turn: 'agent' }),
        aConversation({ id: 'c', turn: 'nobody' }),
      ],
      'ariadne',
    )

    expect(line).toContain('3 open')
    expect(line).toContain('1 on you')
    expect(line).toContain('1 on ariadne')
    expect(line).toContain('1 on nobody')
  })

  it('shows who wrote each entry and when', () => {
    const html = aPage({
      conversations: [
        aConversation({
          entries: [
            {
              author: 'operator',
              body: 'I have asked the provider.',
              createdAt: '2026-08-14T00:00:00.000Z',
            },
            { author: 'agent', body: 'Thank you, waiting.', createdAt: '2026-08-14T01:00:00.000Z' },
          ],
        }),
      ],
    })

    expect(html).toContain('You')
    expect(html).toContain('ariadne')
    expect(html).toContain('I have asked the provider.')
    expect(html).toContain('Thank you, waiting.')
  })

  /**
   * The criterion the issue states outright, and the one worth a test of its
   * own: the value string must be absent from the HTML, not merely unlabelled.
   */
  it('never renders a secret slot value', () => {
    const html = aPage({
      conversations: [
        aConversation({
          slots: [aSlot({ secret: true, value: 'hunter2-would-be-a-leak', filled: true })],
        }),
      ],
    })

    expect(html).not.toContain('hunter2-would-be-a-leak')
    expect(html).toContain('Read it')
  })

  /** A non-secret is on the page, because selecting it is the copy. */
  it('renders a non-secret slot value', () => {
    const html = aPage({
      conversations: [
        aConversation({ slots: [aSlot({ value: 'ariadne+recovery@mail.example' })] }),
      ],
    })

    expect(html).toContain('ariadne+recovery@mail.example')
  })

  /** *There was a value here and it is gone* is a different answer from *never*. */
  it('says a spent slot is gone rather than empty', () => {
    const html = aPage({
      conversations: [aConversation({ slots: [aSlot({ secret: true, gone: true })] })],
    })

    expect(html).toContain('it is gone')
    expect(html).not.toContain('Read it')
  })

  /**
   * Writing is not taking the ball. Two forms, so an operator can say *I have
   * asked our provider and I am waiting* without also claiming the next move.
   */
  it('offers the note and the turn as separate forms', () => {
    const html = aPage({ conversations: [aConversation({ turn: 'agent' })] })

    expect(html).toContain(`/agents/${AGENT}/accounts/${ACCOUNT}/note`)
    expect(html).toContain(`/agents/${AGENT}/accounts/${ACCOUNT}/turn`)
  })

  /** D-013: no button whose only answer is a refusal. */
  it('does not offer to take a turn the reader already holds', () => {
    const html = aPage({ conversations: [aConversation({ turn: 'operator' })] })

    expect(html).not.toContain('I will take it from here')
    expect(html).toContain('Over to ariadne')
  })

  /** The openers, and only where there is nothing already open to write into. */
  it('offers to start something only when nothing is open', () => {
    expect(aPage({ conversations: [] })).toContain(`/agents/${AGENT}/accounts/${ACCOUNT}/open`)
    expect(aPage({ conversations: [aConversation()] })).not.toContain(
      `/agents/${AGENT}/accounts/${ACCOUNT}/open`,
    )
  })

  /**
   * The storage's word, on a page read by the person who bought the mailbox.
   * *Episode* is jargon for *a thing that happened*, and the issue rules it out.
   */
  it('does not use the word episode', () => {
    const html = aPage({
      conversations: [aConversation({ entries: [], slots: [aSlot()] })],
    })

    expect(html.toLowerCase()).not.toContain('episode')
  })

  /** No JavaScript, matching `default-src 'none'` — every act here is a form. */
  it('carries no script', () => {
    const html = aPage({ conversations: [aConversation({ slots: [aSlot({ secret: true })] })] })

    expect(html).not.toContain('<script')
    expect(html).not.toContain('onclick')
  })

  it('says how a closed conversation ended, and why when it failed', () => {
    const html = aPage({
      conversations: [
        aConversation({
          outcome: 'failed',
          turn: 'nobody',
          wall: 'the provider closed the account',
          closedAt: '2026-08-14T02:00:00.000Z',
        }),
      ],
    })

    expect(html).toContain('it failed')
    expect(html).toContain('the provider closed the account')
  })

  /** An account that works has an empty history, and that is worth saying. */
  it('says plainly when nothing has ever happened', () => {
    expect(aPage({ conversations: [] })).toContain('Nothing has ever happened to this account')
  })
})
