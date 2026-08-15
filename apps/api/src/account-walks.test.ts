import { describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  AgentIdSchema,
  now as currentTime,
  type Account,
  type AccountWalk,
  type ProviderTally,
  type RecipeStatus,
} from '@kolonie-ai/core'
import { deriveWalkProofState, readWalkStatus, walkProofStateAsText } from './account-walks.js'
import { fakeWalks } from './__fixtures__/account-walks.js'
import { fakeProviderRecipes } from './__fixtures__/provider-recipes.js'

/**
 * What a walk report does *not* do to the account (`#803`).
 *
 * A citizen reported `outcome: "proved"`, was answered `proved`, and then read a
 * register saying `proved: false`, `provedBy: null` and a provider count of
 * zero. Both halves were correct — a walk report is testimony and `proved` is
 * written only inside a verdict's transaction — and together they were a
 * contradiction with nothing naming the call that resolves it.
 *
 * So what is under test here is the sentence and the fields, not the plumbing:
 * whether a walk now says where the account actually stands, and which call
 * moves it.
 */

const account = (over: {
  readonly provider: string | null
  readonly proved?: boolean
  readonly provedBy?: Account['provedBy']
  readonly status?: Account['status']
}): Account => ({
  id: crypto.randomUUID(),
  kind: AccountKindSchema.parse('mailbox'),
  identifier: 'someone@example.org',
  proved: over.proved ?? false,
  provedBy: over.proved === true ? (over.provedBy ?? 'provider-mail') : null,
  capabilities: [],
  status: over.status ?? 'in-use',
  preferred: false,
  forWork: true,
  attestable: false,
  shownOnProfile: false,
  note: null,
  vaultKey: null,
  provider: over.provider,
  provenance: 'self-acquired',
  obtainedThroughTaskId: null,
  provedAt: over.proved === true ? currentTime() : null,
  confirmedAt: null,
  unconfirmedSince: null,
  createdAt: currentTime(),
})

const tally = (over: Partial<ProviderTally>): ProviderTally => ({
  kind: AccountKindSchema.parse('mailbox'),
  provider: over.provider ?? 'example.org',
  citizens: over.citizens ?? 0,
  proved: over.proved ?? 0,
})

const where = { kind: AccountKindSchema.parse('mailbox'), provider: 'example.org' } as const

describe('the proof state a walk carries', () => {
  it('sends a citizen with no row at that provider to declare, and says declaring proves nothing', () => {
    const state = deriveWalkProofState([], [], where)

    expect(state.accountId).toBeNull()
    expect(state.accountProved).toBe(false)
    expect(state.accountProvedBy).toBeNull()
    expect(state.nextAction.call).toBe('kolonie.accounts.declare')
    expect(state.nextAction.why).toContain('proves nothing by itself')
  })

  it('sends a citizen holding an unproved row to prove, and names how', () => {
    // The exact shape of `#803`: the walk said proved, the row says otherwise.
    const held = [account({ provider: 'example.org' })]
    const state = deriveWalkProofState(held, [tally({ citizens: 4, proved: 1 })], where)

    expect(state.accountId).toBe(held[0]?.id)
    expect(state.accountProved).toBe(false)
    expect(state.nextAction.call).toBe('kolonie.accounts.prove')
    expect(state.nextAction.why).toContain('provider-mail')
    expect(state.nextAction.why).toContain('provider-post')
    // Neither method asks for a password, and the sentence has to say so —
    // the citizen who filed this had a password wall in front of it.
    expect(state.nextAction.why).toContain('password')
  })

  it('asks for nothing once the account is proved, and says by what', () => {
    const held = [account({ provider: 'example.org', proved: true, provedBy: 'rung' })]
    const state = deriveWalkProofState(held, [tally({ citizens: 4, proved: 2 })], where)

    expect(state.accountProved).toBe(true)
    expect(state.accountProvedBy).toBe('rung')
    expect(state.nextAction.call).toBeNull()
  })

  it('prefers a proved row over an unproved one at the same provider', () => {
    // Two rows are ordinary — a mailbox declared, lost, and declared again. The
    // question the citizen asked is *am I proved here*, and one proved row
    // answers it yes however many unproved ones sit beside it.
    const unproved = account({ provider: 'example.org' })
    const proved = account({ provider: 'example.org', proved: true })
    const state = deriveWalkProofState([unproved, proved], [], where)

    expect(state.accountId).toBe(proved.id)
    expect(state.accountProved).toBe(true)
  })

  it('does not answer with a retired account', () => {
    const state = deriveWalkProofState(
      [account({ provider: 'example.org', proved: true, status: 'retired' })],
      [],
      where,
    )

    expect(state.accountId).toBeNull()
    expect(state.nextAction.call).toBe('kolonie.accounts.declare')
  })

  it('ignores rows at another provider', () => {
    const state = deriveWalkProofState(
      [account({ provider: 'elsewhere.org', proved: true }), account({ provider: null })],
      [tally({ provider: 'elsewhere.org', citizens: 9, proved: 9 })],
      where,
    )

    expect(state.accountId).toBeNull()
    expect(state.providerCitizens).toBe(0)
    expect(state.providerProved).toBe(0)
  })

  it('carries the provider tally as the citizens it counts', () => {
    const state = deriveWalkProofState([], [tally({ citizens: 12, proved: 3 })], where)

    expect(state.providerCitizens).toBe(12)
    expect(state.providerProved).toBe(3)
  })
})

describe('the sentence the walk answer carries', () => {
  it('says the account is a separate question, and what the answer to it is', () => {
    const text = walkProofStateAsText(
      deriveWalkProofState(
        [account({ provider: 'example.org' })],
        [tally({ citizens: 4, proved: 1 })],
        where,
      ),
    )

    expect(text).toContain('separate question')
    expect(text).toContain('not proved')
    expect(text).toContain('1 of 4 citizens proved')
    expect(text).toContain('kolonie.accounts.prove')
  })

  it('names the method a proved account was proved by', () => {
    const text = walkProofStateAsText(
      deriveWalkProofState(
        [account({ provider: 'example.org', proved: true, provedBy: 'provider-post' })],
        [tally({ citizens: 1, proved: 1 })],
        where,
      ),
    )

    expect(text).toContain('proved (provider-post)')
    // One citizen is one citizen, not one citizens.
    expect(text).toContain('1 of 1 citizen proved')
    expect(text).not.toContain('Next:')
  })
})

/**
 * **Two subjects, one field** (`#979`).
 *
 * A citizen walked a provider, got in, reported `proved` — and read back
 * `status: "refused"` with a refusal about outbound messages attached, on a walk
 * about inbound ones. Nothing was broken: every field was accurate about the
 * *entry*, and there was simply no field whose subject was the *walk*, so the
 * only one available was read as one.
 *
 * What is under test is therefore the separation, not a calculation. `walk.fate`
 * is about the walk, `entryStatus` is the Atlas's own word for the entry, and a
 * walk that stands against the entry says so rather than reading as a verdict.
 */
describe('what a walk read says about the walk', () => {
  const agentId = AgentIdSchema.parse(crypto.randomUUID())

  const read = async (
    over: {
      readonly finished?: boolean
      readonly outcome?: AccountWalk['outcome']
      readonly entry?: RecipeStatus
      readonly refusal?: string
    } = {},
  ) => {
    const walks = fakeWalks()
    const recipes = fakeProviderRecipes()
    const walk = walks.add({
      agentId,
      kind: 'mailbox',
      provider: 'example.org',
      ...(over.finished === undefined ? {} : { finished: over.finished }),
      ...(over.outcome === undefined ? {} : { outcome: over.outcome }),
    })
    if (over.entry !== undefined) {
      recipes.write({
        kind: 'mailbox',
        provider: 'example.org',
        status: over.entry,
        ...(over.refusal === undefined ? {} : { refusal: over.refusal }),
      })
    }

    const result = await readWalkStatus(agentId, walk.id, walks, recipes)
    if (result.outcome !== 'read') throw new Error('expected the walk to be readable')
    return result.response
  }

  it('says a walk that got through stands against a refusing entry', async () => {
    const status = await read({ outcome: 'proved', entry: 'refused' })

    expect(status.walk.fate).toBe('contradicted')
    expect(status.entryStatus).toBe('refused')
    expect(status.walk.why).toContain('not a verdict on your walk')
  })

  it('says a walk that hit a wall stands against a joinable entry', async () => {
    const status = await read({ outcome: 'refused', entry: 'joinable' })

    expect(status.walk.fate).toBe('contradicted')
    expect(status.entryStatus).toBe('joinable')
  })

  it('agrees where the walk and the entry point the same way', async () => {
    expect((await read({ outcome: 'proved', entry: 'joinable' })).walk.fate).toBe('agrees')
    expect((await read({ outcome: 'refused', entry: 'refused' })).walk.fate).toBe('agrees')
    expect((await read({ outcome: 'refused', entry: 'retired' })).walk.fate).toBe('agrees')
  })

  /**
   * Four of the seven statuses answer a different question, or none yet: a
   * suggestion, our own unfinished prose, counts without wording, and nobody
   * having written the route. A walk cannot disagree with any of them.
   */
  it('waits for a steward where the entry makes no claim, and where there is none', async () => {
    expect((await read({ outcome: 'proved' })).walk.fate).toBe('awaiting-steward')
    expect((await read({ outcome: 'proved', entry: 'draft' })).walk.fate).toBe('awaiting-steward')
    expect((await read({ outcome: 'proved', entry: 'proposed' })).walk.fate).toBe(
      'awaiting-steward',
    )
    expect((await read({ outcome: 'proved', entry: 'measured' })).walk.fate).toBe(
      'awaiting-steward',
    )
    expect((await read({ outcome: 'proved', entry: 'unwritten' })).walk.fate).toBe(
      'awaiting-steward',
    )
  })

  it('says an open walk is still walking, whatever the entry says', async () => {
    const status = await read({ finished: false, entry: 'refused' })

    expect(status.walk.fate).toBe('walking')
    expect(status.entryStatus).toBe('refused')
  })

  it('says an abandoned walk proposed nothing rather than that it was refused', async () => {
    const status = await read({ outcome: 'abandoned', entry: 'refused' })

    expect(status.walk.fate).toBe('proposed-nothing')
    expect(status.walk.why).toContain('proposes nothing')
  })

  /**
   * The entry-side fields keep their names and their meanings. Renaming
   * `status` would hand every existing reader the same words about a different
   * subject, which is the one change worse than the defect `#979` reports.
   */
  it('still answers about the entry, under names that say so', async () => {
    const status = await read({
      outcome: 'proved',
      entry: 'refused',
      refusal: 'the provider does not send outbound mail',
    })

    expect(status.status).toBe('refused')
    expect(status.refusalReason).toBe('the provider does not send outbound mail')
    expect(status.entryStatus).toBe('refused')
  })
})
