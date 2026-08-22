import { describe, expect, it } from 'vitest'
import {
  accountThreadPage,
  statusLine,
  type Conversation,
  type ConversationSlot,
  type InboxThread,
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

/**
 * What the Atlas has on the provider, on the page where somebody is about to act
 * on it (`#936`).
 *
 * **Three states, three shapes, and the shapes are the assertion.** A reader
 * skimming decides whether a block matters before reading its words, so a
 * warning must be a paragraph they cannot miss and a crib sheet must be folded
 * away until they want it. Rendering all three alike would put the refusal and
 * the reassurance at the same weight.
 */
describe('what the Atlas knows about this provider', () => {
  it('says nothing at all when nobody asked the Atlas', () => {
    const html = aPage()

    expect(html).not.toContain('Atlas')
  })

  it('folds a walked path away and marks it as a hint rather than an instruction', () => {
    const html = aPage({
      atlas: {
        state: 'walked',
        provider: 'mail.example',
        kind: 'mailbox',
        title: 'A mailbox at mail.example',
        steps: ['open the signup page', 'confirm the address'],
        operatorSteps: 1,
      },
    })

    expect(html).toContain('<details>')
    expect(html).toContain('open the signup page')
    expect(html).toContain('confirm the address')
    expect(html).toContain('A hint, not an instruction')
    expect(html).toContain('1 of these needed a person')
  })

  /**
   * `#604`'s rule said steps nobody reviewed must say so where they are read.
   * `#1032` removed the state it was about — a walk writes no steps, so every
   * list that reaches this page is the Colony's own route and the caveat would
   * be false on all of them. The warning that outlives it is the one about the
   * provider having moved on.
   */
  it('warns that the page beats the list, and no longer says a steward is missing', () => {
    const html = aPage({
      atlas: {
        state: 'walked',
        provider: 'mail.example',
        kind: 'mailbox',
        title: 'A mailbox at mail.example',
        steps: ['open the signup page'],
        operatorSteps: 0,
      },
    })

    expect(html).not.toContain('warden')
    expect(html).toContain('the page is right')
  })

  /**
   * D-013's neighbour: the warning must not read as a closed door. A refusal in
   * the Atlas is one walk's finding and the provider is free to have changed its
   * mind, so nothing on this page stops the conversation.
   */
  it('warns about a closed provider without stopping anything', () => {
    const html = aPage({
      atlas: {
        state: 'closed',
        provider: 'shut.example',
        kind: 'mailbox',
        withdrawn: false,
        reason: 'no honest route in',
      },
    })

    expect(html).toContain('not joinable')
    expect(html).toContain('no honest route in')
    expect(html).toContain('Nothing is stopped by this')
    expect(html).not.toContain('What somebody who walked')
  })

  it('tells a withdrawal from a refusal, because nobody was turned away by one', () => {
    const html = aPage({
      atlas: {
        state: 'closed',
        provider: 'gone.example',
        kind: 'mailbox',
        withdrawn: true,
        reason: null,
      },
    })

    expect(html).toContain('withdrawn')
    expect(html).toContain('No reason was recorded')
  })

  /**
   * The rejection case `#936` names: a provider the Atlas has never heard of is
   * the ordinary early state, and the page carries on as an invitation rather
   * than as a gap.
   */
  it('renders a provider nobody has walked as one quiet line and no warning', () => {
    const html = aPage({ atlas: { state: 'unwalked', provider: 'new.example' } })

    expect(html).toContain('no written path for new.example')
    expect(html).not.toContain('What somebody who walked')
    expect(html).not.toContain('class="notice"')
  })
})

/**
 * The inbox threads about this account (`#1600`).
 *
 * **The join `#1441` and `#1442` left out.** A thread could say which account it
 * was about and could carry a share; nothing could ask an account which threads
 * those were. So the operator worked the account page and the ask lived in the
 * inbox, and neither page mentioned the other.
 */
describe('the messages about this account', () => {
  const aThread = (overrides: Partial<InboxThread> = {}): InboxThread => ({
    id: '55555555-5555-4555-8555-555555555555',
    lastActivityAt: '2026-08-22T09:00:00.000Z',
    unread: 0,
    archived: false,
    shares: [],
    ...overrides,
  })

  it('lists a thread with a link into the inbox', () => {
    const html = aPage({ inboxThreads: [aThread()] })

    expect(html).toContain('Messages about this account')
    expect(html).toContain('/inbox/55555555-5555-4555-8555-555555555555')
  })

  /**
   * **No empty shell** (`#1600`). A heading over nothing says this account has an
   * inbox and that it is empty, and most accounts would rather not claim the
   * first half.
   */
  it('omits the section entirely when there is none', () => {
    expect(aPage({ inboxThreads: [] })).not.toContain('Messages about this account')
    expect(aPage()).not.toContain('Messages about this account')
  })

  it('says how much is waiting on the person', () => {
    expect(aPage({ inboxThreads: [aThread({ unread: 3 })] })).toContain('<strong>3</strong>')
    expect(aPage({ inboxThreads: [aThread({ unread: 0 })] })).toContain('nothing new')
  })

  /**
   * **The case this was written for.** A live share with no reads looked exactly
   * like a thread nobody had opened, from both sides. *Not opened*, *opened* and
   * *answered* are three different next moves and the row has to separate them.
   */
  describe('a credential hanging on the thread', () => {
    const withShare = (share: Partial<InboxThread['shares'][number]>) =>
      aPage({
        inboxThreads: [
          aThread({
            shares: [
              {
                vaultKey: 'toku.example/handle',
                purpose: 'the card, please',
                opened: false,
                operatorWrote: false,
                ended: null,
                ...share,
              },
            ],
          }),
        ],
      })

    it('says plainly when the person has not opened it', () => {
      expect(withShare({})).toContain('you have not opened it')
    })

    it('says when they opened it and did nothing', () => {
      const html = withShare({ opened: true })
      expect(html).toContain('you opened it')
      expect(html).not.toContain('you have not opened it')
    })

    it('says when they answered it', () => {
      expect(withShare({ opened: true, operatorWrote: true })).toContain('you answered it')
    })

    /** `#1574`: an ended share renders as ended rather than vanishing. */
    it('still shows one that has been taken back or has expired', () => {
      expect(withShare({ ended: 'taken-back' })).toContain('taken back')
      expect(withShare({ ended: 'expired' })).toContain('expired')
    })

    /**
     * The key and the purpose were already in the conversation that explains
     * them; the value has never been on this path and must not arrive on it.
     */
    it('carries the key and the purpose and never a value', () => {
      const html = withShare({})
      expect(html).toContain('toku.example/handle')
      expect(html).toContain('the card, please')
    })
  })

  /** History includes what was put away — `#1600` asks for the account whole. */
  it('marks a thread the person has archived rather than hiding it', () => {
    expect(aPage({ inboxThreads: [aThread({ archived: true })] })).toContain('put away')
  })
})
