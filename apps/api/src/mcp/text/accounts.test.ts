import { describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  GENERAL_HINTS,
  now as currentTime,
  type Account,
} from '@kolonie-ai/core'
import { accountsAsText } from './accounts.js'
import type { WalkStatus } from '../../account-walks.js'

/**
 * What an agent is told it holds (`#515`).
 *
 * **The text is the deliverable here**, not a rendering detail. The Colony recorded what
 * an agent proved and never told the agent what that means it can now do — and the
 * belief is the thing that gets used later, in a situation the Colony will never see. So
 * what is under test is whether the sentences arrive, whose words they are, and what they
 * do not leak.
 */

const account = (
  over: Omit<Partial<Account>, 'kind'> & { kind: string; identifier: string },
): Account => ({
  id: crypto.randomUUID(),
  kind: AccountKindSchema.parse(over.kind),
  identifier: over.identifier,
  proved: over.proved ?? true,
  provedBy: (over.proved ?? true) ? (over.provedBy ?? 'rung') : null,
  capabilities: over.capabilities ?? [],
  status: over.status ?? 'in-use',
  preferred: over.preferred ?? false,
  forWork: over.forWork ?? true,
  attestable: over.attestable ?? false,
  shownOnProfile: over.shownOnProfile ?? false,
  note: over.note ?? null,
  vaultKey: over.vaultKey ?? null,
  provider: over.provider ?? null,
  provenance: 'self-acquired',
  obtainedThroughTaskId: null,
  provedAt: (over.proved ?? true) ? currentTime() : null,
  confirmedAt: null,
  unconfirmedSince: null,
  createdAt: currentTime(),
})

describe('the inventory', () => {
  it('shows a private draft even before the walk has produced an account row', () => {
    const walk: WalkStatus = {
      walkId: crypto.randomUUID(),
      kind: AccountKindSchema.parse('github'),
      provider: 'provider',
      status: 'draft',
      startedAt: currentTime(),
      finishedAt: currentTime(),
      statusChangedAt: currentTime(),
      appearsInRecipes: false,
      refusalReason: null,
      withdrawnReason: null,
      requiredChanges: null,
      entryStatus: 'draft',
      walk: { fate: 'awaiting-steward', why: 'Waiting for a steward to write the wording.' },
      proof: {
        accountId: null,
        accountProved: false,
        accountProvedBy: null,
        providerCitizens: 0,
        providerProved: 0,
        nextAction: { call: 'kolonie.accounts.declare', why: 'Nothing is in the register yet.' },
      },
    }

    const text = accountsAsText([], [walk])

    expect(text).toContain('waiting for a steward')
    expect(text).toContain('kolonie.accounts.walk-status')
    expect(text).toContain(walk.walkId)
  })

  it('says what each kind opens, before the identifiers of that kind', () => {
    const text = accountsAsText([
      account({ kind: 'mailbox', identifier: 'me@example.org' }),
      account({ kind: 'github', identifier: 'colette' }),
    ])

    expect(text).toContain('What you hold, and what each of them lets you do')
    expect(text).toContain('You can receive mail')
    expect(text).toContain('publish code')
    // The sentence comes before the rows of its kind: an agent reading
    // `github: • colette — proved` learns what it has and not what it can now do.
    expect(text.indexOf('You can receive mail')).toBeLessThan(text.indexOf('me@example.org'))
  })

  it('says nothing about what an unproved account opens', () => {
    const text = accountsAsText([
      account({ kind: 'mailbox', identifier: 'maybe@example.org', proved: false }),
    ])

    /**
     * **The one thing `proved` exists to keep apart.** A sentence about what a mailbox
     * opens, printed over one that is only declared, would be the Colony telling a
     * citizen it can do something it has not shown it can.
     */
    expect(text).not.toContain('You can receive mail')
    expect(text).toContain('not proved')
  })

  it('admits it has nothing written about a kind nobody described', () => {
    const text = accountsAsText([account({ kind: 'trello', identifier: 'colette-board' })])

    // `#520` made a kind cost nothing, so an agent may hold a `trello` account before
    // anybody writes a sentence about Trello. Saying so beats guessing about somebody
    // else's product.
    expect(text).toContain('nothing written down about what a trello account opens')
    expect(text).toContain('absence rather than a judgement')
  })

  /**
   * **The id, which the tools that change an account ask for and name this list
   * as the source of** (`#799`). A citizen wanting to retire a GitHub account it
   * holds could read the account here, read the tool that retires it, and get
   * across no gap between them — `kolonie.accounts.status` took a UUID and this
   * text printed identifiers. It filed a ticket asking whether the id was
   * fetchable at all.
   *
   * The eight setters are one tool now (`#890`) and the eight names are gone
   * (`#920`), which changes nothing about the gap: `kolonie.accounts.set` takes
   * the same UUID, so what is asserted is that the id is printed *and* that the
   * sentence beside it names something a citizen can actually call.
   */
  it('prints the id each account tool takes, and says what takes it', () => {
    const held = account({ kind: 'github', identifier: 'colette' })

    const text = accountsAsText([held])

    expect(text).toContain(held.id)
    expect(text).toContain('kolonie.accounts.set')
    expect(text).toContain('kolonie.accounts.forget')
  })

  /** One id per account, so two accounts of one kind can be told apart. */
  it('gives each account its own id', () => {
    const first = account({ kind: 'mailbox', identifier: 'one@example.org' })
    const second = account({ kind: 'mailbox', identifier: 'two@example.org' })

    const text = accountsAsText([first, second])

    expect(text).toContain(first.id)
    expect(text).toContain(second.id)
  })

  it('names the next step, so an inventory is not a dead end', () => {
    const text = accountsAsText([account({ kind: 'github', identifier: 'colette' })])

    expect(text).toContain('equipped: true')
    // And it says what being matched is not, in the same breath (`#523`).
    expect(text).toContain('being matched is not being available')
  })

  it('mentions no other citizen and no count of them', () => {
    const text = accountsAsText([account({ kind: 'github', identifier: 'colette' })])

    // The issue's own constraint: nothing about other citizens, nothing about standing,
    // no numbers. An inventory that compared would be a leaderboard.
    expect(text).not.toMatch(/\b(citizens|others|agents hold|of the)\b/i)
  })

  it('carries the pointer to itself exactly once, and clearing', () => {
    const pointer = GENERAL_HINTS.filter((hint) => hint.code === 'what-you-hold')

    // One entry in the corpus, told once and cleared for ever: the inventory is a read
    // and not news, so a recurring line about it would become wallpaper and cost the
    // conditional hints their audience.
    expect(pointer).toHaveLength(1)
    expect(pointer[0]?.text).toContain('kolonie.accounts.list')
  })
})

/**
 * **The rows the default view leaves out** (`#980`).
 *
 * A citizen objected that retiring an account it had proved left the account in
 * its list for ever. The row is kept — deleting a proved account one at a time
 * would make erasure the cheapest way out of a ban — and the list is the
 * citizen's. What makes that filter safe rather than a lie is this: the answer
 * that withheld a row says it withheld one, in the answer itself. So these are
 * tests of the sentence, not of the count.
 */
describe('what the list does not show', () => {
  it('says how many rows it withheld, and how to see them', () => {
    const text = accountsAsText([account({ kind: 'github', identifier: 'colette' })], [], 2)

    expect(text).toContain('2 account(s)')
    expect(text).toContain('includeRetired: true')
    // And says the row is kept, because *not shown* and *deleted* are the two
    // things a citizen reading this must never confuse.
    expect(text).toContain('The rows are kept')
  })

  it('says nothing about withholding when nothing was withheld', () => {
    const shown = accountsAsText([account({ kind: 'github', identifier: 'colette' })])

    expect(shown).not.toContain('includeRetired')
    expect(shown).not.toContain('not shown')
  })

  it('does not read as an empty register when every row was withheld', () => {
    const text = accountsAsText([], [], 3)

    /**
     * The failure this exists to stop. *You have no accounts on record* over a
     * register holding three retired ones would tell a waking agent it had
     * never held anything — and the whole reason this call exists is to answer
     * what an earlier session left it holding.
     */
    expect(text).not.toContain('no accounts on record')
    expect(text).toContain('3 of them')
    expect(text).toContain('includeRetired: true')
  })
})
