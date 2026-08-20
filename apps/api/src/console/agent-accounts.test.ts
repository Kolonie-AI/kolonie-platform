import { describe, expect, it } from 'vitest'
import type { Account } from '@kolonie-ai/core'
import { agentAccountsPage, heldAccountRows, type HeldAccountRow } from './agent-accounts.js'

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
 * What state each account is in, on the operator's own screen (`#928`).
 *
 * The list carried counts by kind. `status`, `proved`, `confirmed_at` and
 * `unconfirmed_since` all existed and none of them reached this page, so an
 * account the agent marked `lost` in June read exactly like one re-verified this
 * morning. These assert the four facts, and — as firmly — that the two kinds of
 * *no re-check* do not read alike.
 */
describe('what the agent holds', () => {
  /** RFC 2606 throughout: `AGENTS.md` §3 keeps real hostnames out of the repo. */
  const aRow = (overrides: Partial<HeldAccountRow> = {}): HeldAccountRow => ({
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'mailbox',
    provider: 'mail.example',
    identifier: 'ariadne@mail.example',
    status: 'in-use',
    proved: true,
    confirmedAt: null,
    unconfirmedSince: null,
    ...overrides,
  })

  it('names the account, its provider, what the agent says and when it was checked', () => {
    const html = aPage({
      held: [aRow({ confirmedAt: '2026-08-14T00:00:00.000Z' })],
    })

    expect(html).toContain('ariadne@mail.example')
    expect(html).toContain('mail.example')
    expect(html).toContain('in use')
    expect(html).toContain('proved — the Colony read it')
    expect(html).toContain('answered')
  })

  /**
   * The row the page exists for. An operator who cannot see this has no way of
   * knowing why a quest stopped moving.
   */
  it('says when the agent has stopped counting an account as current', () => {
    const html = aPage({ held: [aRow({ status: 'lost' })] })

    expect(html).toContain('<strong>lost</strong>')
    expect(html).not.toContain('in use')
  })

  /**
   * **The distinction the acceptance criteria name.** A failed re-check and one
   * that never ran are different facts about the world, and a page that renders
   * them alike is telling the operator something untrue about one of them.
   */
  it('does not let a failed re-check read like one that never ran', () => {
    const failed = aPage({ held: [aRow({ unconfirmedSince: '2026-08-01T00:00:00.000Z' })] })
    const never = aPage({ held: [aRow()] })

    expect(failed).toContain('<strong>did not answer</strong>')
    expect(never).not.toContain('did not answer')
    expect(never).toContain('never re-checked since it was proved')
  })

  /** An empty cell reads as a page that forgot to render one. */
  it('says in a sentence that a declared account is not re-checked at all', () => {
    const html = aPage({ held: [aRow({ proved: false, status: 'in-use' })] })

    expect(html).toContain('declared only')
    expect(html).toContain('the Colony re-checks an account once it has been proved')
  })

  /**
   * The reassurance `#934` wrote, on a condition of its own. Closing a
   * maintenance episode stops that section rendering and leaves
   * `unconfirmed_since` set, so without this the operator reads *did not answer*
   * with nothing beside it saying what it costs.
   */
  it('says nothing was taken away beside a failure, and not otherwise', () => {
    expect(aPage({ held: [aRow({ unconfirmedSince: '2026-08-01T00:00:00.000Z' })] })).toContain(
      'has had nothing taken away',
    )
    expect(aPage({ held: [aRow({ confirmedAt: '2026-08-14T00:00:00.000Z' })] })).not.toContain(
      'has had nothing taken away',
    )
  })

  /** A blank cell is not an answer; the provider was simply never named. */
  it('says a provider was not recorded rather than leaving the cell empty', () => {
    expect(aPage({ held: [aRow({ provider: null })] })).toContain('not recorded')
  })

  it('renders no table when the agent holds nothing', () => {
    expect(aPage({ held: [] })).toContain('Nothing here yet')
  })

  /**
   * The projection, on the register's own rows.
   *
   * **Retired and lost survive it.** `listAccounts` returns them for the
   * citizen's own view because they are excluded from offering rather than from
   * the record, and *how are my agent's accounts doing* is that same question
   * asked by the person who operates it.
   */
  describe('the projection', () => {
    const anAccount = (overrides: Partial<Account> = {}): Account =>
      ({
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'mailbox',
        identifier: 'ariadne@mail.example',
        proved: true,
        capabilities: [],
        status: 'in-use',
        preferred: false,
        forWork: true,
        attestable: false,
        shownOnProfile: false,
        note: 'sending unlocks after 48 hours',
        vaultKey: 'mail/ariadne',
        provenance: 'self-acquired',
        obtainedThroughTaskId: null,
        provedBy: 'rung',
        provedAt: '2026-07-01T00:00:00.000Z',
        confirmedAt: null,
        unconfirmedSince: null,
        provider: 'mail.example',
        createdAt: '2026-07-01T00:00:00.000Z',
        ...overrides,
      }) as Account

    it('keeps retired and lost rows', () => {
      const rows = heldAccountRows([
        anAccount({ status: 'retired' }),
        anAccount({ status: 'lost' }),
      ])

      expect(rows.map((row) => row.status)).toEqual(['retired', 'lost'])
    })

    /**
     * What belongs to the citizen and not to its operator: the note it wrote
     * itself, and the vault key that opens the account. The row id is kept since
     * `#932`, because the account's own page is the form that spends it.
     */
    it('drops the note and the vault key', () => {
      const [row] = heldAccountRows([anAccount()])

      expect(Object.keys(row ?? {}).sort()).toEqual([
        'confirmedAt',
        'id',
        'identifier',
        'kind',
        'proved',
        'provider',
        'status',
        'unconfirmedSince',
      ])
    })

    /** The line is followable, which is the whole of what the id buys (`#932`). */
    it('makes the identifier a link to the account', () => {
      expect(aPage({ held: [aRow({ id: '33333333-3333-4333-8333-333333333333' })] })).toContain(
        'href="/agents/11111111-1111-4111-8111-111111111111/accounts/' +
          '33333333-3333-4333-8333-333333333333"',
      )
    })
  })
})

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

/**
 * The form that hands an agent an account it never asked for (`#933`).
 *
 * Every other channel on this page runs the other way — the agent asks and the
 * operator answers. These assert the three things that make this one safe to
 * put in front of a person: that it takes the values rather than instructions,
 * that it says plainly the agent may decline, and that a form which could not
 * land says so on the way back.
 */
describe('handing your agent an account', () => {
  it('asks what the account is and what opens it', () => {
    const html = aPage()

    expect(html).toContain('Handing your agent an account')
    expect(html).toContain(`action="/agents/${AGENT}/accounts/handover"`)
    expect(html).toContain('name="kind"')
    expect(html).toContain('name="identifier"')
    expect(html).toContain('name="provider"')
    // Three rows of label/value/seal, so a sign-in name, a password and one more.
    for (const n of [1, 2, 3]) {
      expect(html).toContain(`name="label${n}"`)
      expect(html).toContain(`name="value${n}"`)
      expect(html).toContain(`name="secret${n}"`)
    }
  })

  /**
   * The kinds the Colony knows are offered and none of them is imposed:
   * `AccountKindSchema` takes any well-formed slug, so a closed `<select>`
   * would refuse an account the Colony simply has no rung for yet.
   */
  it('suggests the known kinds without closing the list', () => {
    const html = aPage()

    expect(html).toContain('<datalist id="account-kinds">')
    expect(html).toContain('<option value="mailbox">')
    expect(html).not.toContain('<select name="kind"')
  })

  /**
   * `#933`'s rejection case, said out loud. An agent that closes this as
   * abandoned loses nothing, and an operator who believes otherwise will read a
   * declined gift as a fault.
   */
  it('says the agent decides and loses nothing by declining', () => {
    const html = aPage()

    expect(html).toContain('Your agent decides what to do with it')
    expect(html).toContain('No reputation, no skill, no standing changes')
  })

  /**
   * The page says three inches higher that a secret typed into the wish list is
   * refused. Without this paragraph the two read as a contradiction.
   */
  it('names the difference between this form and the wish list', () => {
    expect(aPage()).toContain('sealed the moment you submit it')
  })

  /** D-062: no JavaScript on a console page, so nothing here needs any. */
  it('needs no script', () => {
    expect(aPage()).not.toContain('<script')
  })

  /**
   * A handover that could not land has no account page to arrive at, so it
   * comes back here — and a page that came back untouched would read as a form
   * that quietly did nothing.
   */
  it('carries what the last write said, when there was one', () => {
    expect(aPage({ notice: 'Nothing was handed over: your agent’s register is full.' })).toContain(
      'Nothing was handed over: your agent’s register is full.',
    )
    expect(aPage()).not.toContain('Nothing was handed over')
  })
})

/**
 * The move from a wanted wish to a conversation (`#936`).
 *
 * **The mark was the end of the road.** An operator said yes, the agent was
 * woken, and the row's only remaining control was *Remove* — so both parties sat
 * waiting for the other to open something. These assert the button, the two
 * fields it cannot do without, and that a wish whose conversation exists offers
 * the way in rather than a second form.
 */
describe('a wanted wish becomes a conversation', () => {
  const aWish = (overrides: Record<string, unknown> = {}) =>
    ({
      id: '33333333-3333-4333-8333-333333333333',
      provider: 'mail.example',
      author: 'operator',
      noticedWhile: null,
      wantedAt: '2026-08-10T00:00:00.000Z',
      addedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    }) as never

  it('offers no start form until the operator has said yes', () => {
    const html = aPage({ wishes: [aWish({ wantedAt: null })] })

    expect(html).toContain('/wishes/want')
    expect(html).not.toContain('/wishes/start')
  })

  /**
   * An episode needs an account and an account needs both fields, so the form
   * asks for both. A placeholder identifier would be permanently wrong with no
   * rename path, which is D-002 arriving as a convenience.
   */
  it('asks for the kind and the identifier, because an account cannot exist without either', () => {
    const html = aPage({ wishes: [aWish()] })

    expect(html).toContain('/wishes/start')
    expect(html).toContain('name="kind"')
    expect(html).toContain('name="identifier"')
    expect(html).toContain('Start the conversation')
  })

  /** A prefill and not a constraint: the field stays a datalist, never a select. */
  it('prefills the kind the catalogue walked and leaves the field open', () => {
    const html = aPage({
      wishes: [aWish()],
      catalogue: {
        'mail.example': {
          status: 'joinable',
          operatorNeed: 'unaided',
          refusal: null,
          kind: 'mailbox',
        },
      },
    })

    expect(html).toContain('list="account-kinds"')
    expect(html).toContain('value="mailbox"')
    expect(html).not.toContain('<select name="kind"')
  })

  /**
   * D-013: a second acquisition about one account is refused downstream, so
   * offering the button anyway would be building one whose only answer is no.
   */
  it('shows the way in rather than a second form once the conversation exists', () => {
    const html = aPage({
      wishes: [aWish()],
      conversations: { 'mail.example': '44444444-4444-4444-8444-444444444444' },
    })

    expect(html).toContain('Open the conversation')
    expect(html).toContain(`/agents/${AGENT}/accounts/44444444-4444-4444-8444-444444444444`)
    expect(html).not.toContain('/wishes/start')
  })

  /** Removing is still the way to withdraw a yes, conversation or not. */
  it('keeps the removal on the row either way', () => {
    expect(aPage({ wishes: [aWish()] })).toContain('/wishes/remove')
    expect(aPage({ wishes: [aWish()], conversations: { 'mail.example': 'x' } })).toContain(
      '/wishes/remove',
    )
  })
})

/**
 * The sealed box, and the way into it (`#1027`).
 *
 * **A channel that worked and could not be found.** An agent has been able to
 * seal a secret since `#592`, the listing to render it has existed as long, and
 * the only route that opens one takes an id in its path that no page printed —
 * so an operator not handed a UUID by hand had no way to a value their agent had
 * put there for them. `#918` is the same silence measured from the other end: it
 * fixed *nobody could ever read it*, this is *nobody could find it*.
 *
 * These assert the section, that it never carries the value, that a wish row at
 * that provider says so, and that the deep link to an open question is the
 * anchor rather than the durable token `#587` and `#428` keep out of a
 * signed-in page.
 */
describe('what your agent has sealed for you', () => {
  const HANDOVER = '55555555-5555-4555-8555-555555555555'

  const aSecret = (overrides: Record<string, unknown> = {}) =>
    ({
      id: HANDOVER,
      provider: 'mail.example',
      prompt: 'The password for the mailbox at mail.example.',
      expiresAt: '2026-08-16T12:00:00.000Z',
      readsLeft: 3,
      ...overrides,
    }) as never

  const aWish = (overrides: Record<string, unknown> = {}) =>
    ({
      id: '33333333-3333-4333-8333-333333333333',
      provider: 'mail.example',
      author: 'citizen',
      noticedWhile: null,
      wantedAt: '2026-08-10T00:00:00.000Z',
      addedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    }) as never

  /** The control that did not exist anywhere before this. */
  it('offers the way in, as a form and not a link', () => {
    const html = aPage({ sealed: [aSecret()] })

    expect(html).toContain('What your agent has sealed for you')
    expect(html).toContain(`action="/handovers/${HANDOVER}"`)
    expect(html).toContain('method="post"')
    expect(html).toContain('Open it')
  })

  /**
   * A GET would let a prefetch, a crawler or a back button spend a read of a
   * live credential — the reason the route is a POST, held here too.
   */
  it('does not offer it as something a browser might follow on its own', () => {
    expect(aPage({ sealed: [aSecret()] })).not.toContain(`href="/handovers/${HANDOVER}"`)
  })

  /** Both are irreversible and neither is guessable from a button. */
  it('says what opening it costs before the button, and when it goes by itself', () => {
    const html = aPage({ sealed: [aSecret()] })

    expect(html).toContain('Opening it spends a read')
    expect(html).toContain('whether or not anybody came')
    expect(html).toContain('>3<')
  })

  /** The one thing this page must never carry: the plaintext. */
  it('carries the sentence the Colony wrote and no value', () => {
    const html = aPage({ sealed: [aSecret()] })

    expect(html).toContain('The password for the mailbox at mail.example.')
    expect(html).not.toContain('hunter2')
  })

  /** `maintenance`'s rule: a heading that says nothing is wrong is one readers skip. */
  it('renders no section at all when nothing is sealed', () => {
    expect(aPage()).not.toContain('What your agent has sealed for you')
    expect(aPage({ sealed: [] })).not.toContain('What your agent has sealed for you')
  })

  /**
   * The row is where the operator is looking when they wonder what happened, so
   * it is where the pointer belongs — and it is a pointer, not a second door.
   */
  it('marks the wish row at that provider and anchors it into the section', () => {
    const html = aPage({ wishes: [aWish()], sealed: [aSecret()] })

    expect(html).toContain('A secret is sealed for you')
    expect(html).toContain('href="#sealed"')
    expect(html).toContain('id="sealed"')
  })

  /** A handover may exist at a provider nobody put on the list. */
  it('renders the section for a provider with no wish behind it', () => {
    const html = aPage({ wishes: [], sealed: [aSecret({ provider: 'other.example' })] })

    expect(html).toContain('What your agent has sealed for you')
    expect(html).toContain('other.example')
  })

  /** An agent may seal twice at one provider, and the count is the honest form. */
  it('counts them on the row rather than claiming there is one', () => {
    const html = aPage({
      wishes: [aWish()],
      sealed: [aSecret(), aSecret({ id: '66666666-6666-4666-8666-666666666666' })],
    })

    expect(html).toContain('2 secrets are sealed for you')
  })

  /**
   * `operator_requests.wish_id` had existed since that channel did and nothing on
   * this page read it, so an operator in Accounts never learned their agent had
   * asked them about the row in front of them. `#1325` retired the exchange and
   * `message_conversations.wish_id` carries the join now.
   */
  it('points a wish row at the question waiting on it', () => {
    const html = aPage({
      wishes: [aWish()],
      asks: { 'mail.example': '77777777-7777-4777-8777-777777777777' },
    })

    expect(html).toContain('It has asked you something')
    expect(html).toContain('#question-77777777-7777-4777-8777-777777777777')
  })

  /** `#587`, `#428`: the durable bearer token is not rendered inside a session. */
  it('deep-links through the console path and never the mailed token', () => {
    const html = aPage({
      wishes: [aWish()],
      asks: { 'mail.example': '77777777-7777-4777-8777-777777777777' },
    })

    expect(html).toContain(`/agents/${AGENT}/operator`)
    expect(html).not.toContain('/operator/')
  })

  /** The mark is still the first thing the cell says. */
  it('keeps what the cell already answered', () => {
    expect(aPage({ wishes: [aWish({ wantedAt: null })], sealed: [aSecret()] })).toContain('not yet')
    expect(aPage({ wishes: [aWish()], sealed: [aSecret()] })).toContain('wanted,')
  })
})
