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
