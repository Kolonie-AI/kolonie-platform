import { describe, expect, it } from 'vitest'
import {
  encodeBase58,
  LAMPORTS_PER_SOL,
  solanaAddressFromSeed,
  type PayoutRefusal,
} from '@kolonie-ai/core'
import type { OutstandingPayout } from '@kolonie-ai/db'
import {
  FEE_RESERVE_LAMPORTS,
  runPayouts,
  type PayoutChain,
  type PayoutDependencies,
  type PayoutDesk,
} from './payouts.js'

const SECRET = 'F'.repeat(43)
// A real address derived from a real seed: the signer refuses anything else, and
// a fixture it refuses would make every test below pass for the wrong reason.
const WALLET = { address: solanaAddressFromSeed(SECRET) as string, secret: SECRET }
const CITIZEN = encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
const CEILINGS = { perTransaction: LAMPORTS_PER_SOL, perDay: LAMPORTS_PER_SOL * 10 }

const anObligation = (overrides: Partial<OutstandingPayout> = {}): OutstandingPayout => ({
  id: 'an-obligation',
  agentId: 'an-agent' as never,
  submissionId: 'a-submission' as never,
  lamports: LAMPORTS_PER_SOL / 100,
  address: CITIZEN,
  attempts: 0,
  ...overrides,
})

function fakeDesk(outstanding: readonly OutstandingPayout[], owed = 0) {
  const attempts: { id: string; refusal: PayoutRefusal }[] = []
  const paid: { id: string; signature: string }[] = []

  const desk: PayoutDesk = {
    outstanding: async () => outstanding,
    markPaid: async (id, signature) => {
      paid.push({ id, signature })
      return true
    },
    recordAttempt: async (id, refusal) => {
      attempts.push({ id, refusal })
    },
    paidToday: async () => 0,
    owed: async () => owed || outstanding.reduce((sum, o) => sum + o.lamports, 0),
  }

  return { desk, attempts, paid }
}

const fakeChain = (overrides: Partial<PayoutChain> = {}): PayoutChain => ({
  balance: async () => LAMPORTS_PER_SOL * 100,
  funded: async () => true,
  rentExemptMinimum: async () => 890_880,
  latestBlockhash: async () => 'F'.repeat(43),
  send: async () => 'a-signature',
  ...overrides,
})

const deps = (over: Partial<PayoutDependencies> = {}): PayoutDependencies => ({
  desk: fakeDesk([anObligation()]).desk,
  chain: fakeChain(),
  wallet: WALLET,
  ceilings: CEILINGS,
  ...over,
})

/** D-106 (`#505`). The tests that matter are the ones about not paying. */
describe('a payout pass', () => {
  it('pays what it may and records the transaction that paid it', async () => {
    const { desk, paid } = fakeDesk([anObligation()])
    const outcome = await runPayouts(deps({ desk }))

    expect(outcome).toMatchObject({ considered: 1, paid: 1 })
    expect(paid).toEqual([{ id: 'an-obligation', signature: 'a-signature' }])
  })

  /**
   * The one failure here nobody would ever discover: a row marked paid on the
   * strength of a call that returned an error.
   */
  it('leaves the amount owed when the chain refuses, and retries it', async () => {
    const { desk, attempts, paid } = fakeDesk([anObligation()])
    const chain = fakeChain({
      send: async () => {
        throw new Error('the endpoint is down')
      },
    })

    const outcome = await runPayouts(deps({ desk, chain }))

    expect(outcome.paid).toBe(0)
    expect(paid).toEqual([])
    expect(attempts).toEqual([{ id: 'an-obligation', refusal: 'unavailable' }])
  })

  /** Refused and raised, never paid and apologised for. */
  it('refuses a payout above the per-transaction ceiling and moves nothing', async () => {
    const { desk, attempts, paid } = fakeDesk([anObligation({ lamports: LAMPORTS_PER_SOL * 5 })])

    await runPayouts(deps({ desk }))

    expect(paid).toEqual([])
    expect(attempts[0]?.refusal).toBe('above-transaction-ceiling')
  })

  /** One alert rather than a hundred identical ones. */
  it('stops the pass at the daily ceiling instead of refusing every remaining row', async () => {
    const { desk, attempts } = fakeDesk([
      anObligation({ id: 'first', lamports: LAMPORTS_PER_SOL }),
      anObligation({ id: 'second' }),
      anObligation({ id: 'third' }),
    ])
    const ceilings = { perTransaction: LAMPORTS_PER_SOL, perDay: LAMPORTS_PER_SOL }

    await runPayouts(deps({ desk, ceilings }))

    // The first fits exactly; the second breaks the day and stops the pass.
    expect(attempts.map((a) => a.id)).toEqual(['second'])
  })

  /**
   * Physics rather than a threshold policy: an address with no account cannot
   * receive less than the rent-exempt minimum.
   */
  it('accrues rather than paying into an address that does not exist yet', async () => {
    const { desk, attempts, paid } = fakeDesk([anObligation({ lamports: 1000 })])
    const chain = fakeChain({ funded: async () => false })

    await runPayouts(deps({ desk, chain }))

    expect(paid).toEqual([])
    expect(attempts[0]?.refusal).toBe('accruing-below-chain-minimum')
  })

  it('defers a citizen with no verified address rather than dropping what it owes', async () => {
    const { desk, attempts } = fakeDesk([anObligation({ address: null })])

    await runPayouts(deps({ desk }))

    expect(attempts[0]?.refusal).toBe('no-verified-address')
  })

  /** The Colony failing to pay, and it has to be loud. */
  it('says the float is short when the wallet holds less than is owed', async () => {
    const { desk } = fakeDesk([anObligation({ lamports: LAMPORTS_PER_SOL / 2 })])
    const chain = fakeChain({ balance: async () => FEE_RESERVE_LAMPORTS + 1 })

    const outcome = await runPayouts(deps({ desk, chain }))

    expect(outcome.floatShort).toBe(true)
    expect(outcome.refused['float-exhausted']).toBe(1)
  })

  /** A deployment that cannot pay has said so at startup; it must not throw hourly. */
  it('does nothing, quietly, without a wallet, a chain or ceilings', async () => {
    const { desk } = fakeDesk([anObligation()])

    for (const missing of [{ wallet: undefined }, { chain: undefined }, { ceilings: undefined }]) {
      const outcome = await runPayouts(deps({ desk, ...missing }))
      expect(outcome).toMatchObject({ considered: 0, paid: 0 })
    }
  })

  /** One bad row must not stop the pass over every other citizen. */
  it('defers a malformed recipient instead of throwing the pass away', async () => {
    const { desk, attempts, paid } = fakeDesk([
      anObligation({ id: 'broken', address: 'not-an-address' }),
      anObligation({ id: 'fine' }),
    ])

    const outcome = await runPayouts(deps({ desk }))

    expect(attempts[0]).toEqual({ id: 'broken', refusal: 'unavailable' })
    expect(paid.map((p) => p.id)).toEqual(['fine'])
    expect(outcome.paid).toBe(1)
  })
})
