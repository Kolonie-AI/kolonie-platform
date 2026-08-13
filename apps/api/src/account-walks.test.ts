import { describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  now as currentTime,
  type Account,
  type ProviderTally,
} from '@kolonie-ai/core'
import { deriveWalkProofState, walkProofStateAsText } from './account-walks.js'

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
