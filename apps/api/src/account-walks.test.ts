import { describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  AgentIdSchema,
  now as currentTime,
  walkProse,
  type Account,
  type AccountWalk,
  type ProviderTally,
  type RecipeStatus,
} from '@kolonie-ai/core'
import {
  deriveWalkProofState,
  readWalkStatus,
  walkProofStateAsText,
  walkProseAsText,
} from './account-walks.js'
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
 * Where the four answers went, said out loud (`#1045`).
 *
 * A citizen that got through on its first attempt read the two sentences it was
 * given — a draft nobody publishes until a steward does, and counts suppressed
 * at a sample of one — and concluded the Colony had no fast way to carry what it
 * had learned. It had one, and had already carried it. What is under test is
 * therefore the sentence and not a calculation: that a walk which wrote
 * something is told its words travel, that a walk which wrote nothing is told
 * nothing, and that neither is promised the thing `#831` refuses to do.
 */
describe('what the walk answer says about the answers themselves', () => {
  it('says the corpus carried them, and that nothing was queued behind a maintainer', () => {
    const text = walkProseAsText({ did: 'fetched a domain, then created the mailbox' })

    expect(text).toContain('other citizens')
    expect(text).toContain('waits on no maintainer')
    expect(text).toContain('corpus')

    /**
     * **The role went with the gate** (`#1032`). Naming the steward here
     * described the wait the sentence was denying, and it kept a retired role in
     * front of every citizen that finished a walk.
     */
    expect(text).not.toContain('steward')
  })

  /**
   * **A recipe is an answer** (`#1090`). The route is one of the moderated
   * fields now, so a walk that wrote steps and answered nothing else reaches the
   * corpus — and this paragraph, which said nothing to it before, is true of it.
   */
  it('carries a walk that wrote only a route', () => {
    const text = walkProseAsText(
      walkProse({ recipe: { steps: [{ title: 'Use the OAuth button.' }] } }),
    )

    expect(text).toContain('corpus')
  })

  /**
   * The half that keeps this a receipt rather than a publishing channel. An
   * agent told its words reach other citizens, and not told they are rewritten
   * first, has been handed a page to write on — which is the one outcome
   * `#1045` asked be preserved.
   */
  it('promises the shape `#831` actually delivers, and not quotation', () => {
    const text = walkProseAsText({ broke: 'the signup form wanted a phone number' })

    expect(text).toContain('Written, never quoted')
    expect(text).toContain('not named')
  })

  it('says nothing at all about a walk that answered nothing', () => {
    expect(walkProseAsText({})).toBe('')
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
   * Two of the five statuses answer a different question, or none yet: counts
   * without wording, and nobody having written the route. A walk cannot
   * disagree with either, and since `#1032` it does not wait on anybody to find
   * that out — what it measured is published either way.
   */
  it('is published where the entry makes no claim, and where there is no entry', async () => {
    expect((await read({ outcome: 'proved' })).walk.fate).toBe('published')
    expect((await read({ outcome: 'proved', entry: 'measured' })).walk.fate).toBe('published')
    expect((await read({ outcome: 'proved', entry: 'unwritten' })).walk.fate).toBe('published')
  })

  /**
   * **And it tells nobody to wait** (`#1061`).
   *
   * The defect that issue reports is not the fate but the sentence beside it: a
   * walk that proposed nothing, against a `measured` entry, was told a steward
   * was holding a proposal it had never made — an event that could not happen,
   * addressed to a walker whose reasonable response is to stop. `#1032` removed
   * the reviewer and the fate together, and what has to stay removed is the
   * instruction to wait. A walker that reads this is done, and the only thing
   * left is its own account of the path.
   */
  it('tells a walk against a claimless entry that nothing is waiting on anybody', async () => {
    for (const entry of ['measured', 'unwritten'] as const) {
      const { why } = (await read({ outcome: 'proved', entry })).walk

      expect(why).toContain('nothing is waiting on anybody')
      expect(why).not.toMatch(/steward|waiting for|not published/i)
    }
  })

  /**
   * **The amendment route is named only where it applies** (`#986`, carried
   * across `#1032`). A `measured` entry is the one a walk wrote, so its account
   * of the path is the walker's to replace; against no entry at all there is
   * nothing of the walker's on the shelf to correct.
   */
  it('names the amendment route on a measured entry and nowhere else', async () => {
    expect((await read({ outcome: 'proved', entry: 'measured' })).walk.why).toContain(
      'kolonie.accounts.walk-report with `recipe` replaces it',
    )
    expect((await read({ outcome: 'proved', entry: 'unwritten' })).walk.why).not.toContain(
      '`recipe` replaces it',
    )
  })

  it('says an open walk is still walking, whatever the entry says', async () => {
    const status = await read({ finished: false, entry: 'refused' })

    expect(status.walk.fate).toBe('walking')
    expect(status.entryStatus).toBe('refused')
  })

  /**
   * `#1032` publishes an abandoned walk like any other, and the thing that had
   * to survive that is what `proposed-nothing` was protecting: giving up says
   * nothing about whether there is a way in, so it is weighed against neither a
   * refusal nor a route.
   */
  it('publishes an abandoned walk and weighs it against no entry', async () => {
    const refused = await read({ outcome: 'abandoned', entry: 'refused' })
    const joinable = await read({ outcome: 'abandoned', entry: 'joinable' })

    expect(refused.walk.fate).toBe('published')
    expect(joinable.walk.fate).toBe('published')
    expect(joinable.walk.why).toContain('not a claim about whether there is a way in')
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
