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
      requiredChanges: null,
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
