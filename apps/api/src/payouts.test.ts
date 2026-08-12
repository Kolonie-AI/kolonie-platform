import { describe, expect, it } from 'vitest'
import {
  PAYOUT_STUCK_AFTER_ATTEMPTS,
  encodeBase58,
  LAMPORTS_PER_SOL,
  solanaAddressFromSeed,
  type PayoutRefusal,
} from '@kolonie-ai/core'
import type { OutstandingPayout } from '@kolonie-ai/db'
import {
  ChainUnreachableError,
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
  erased: false,
  ...overrides,
})

function fakeDesk(outstanding: readonly OutstandingPayout[], owed = 0) {
  const attempts: { id: string; refusal: PayoutRefusal }[] = []
  const paid: { id: string; signature: string }[] = []
  const forfeited: string[] = []

  const desk: PayoutDesk = {
    outstanding: async () => outstanding,
    markPaid: async (id, signature) => {
      paid.push({ id, signature })
      return true
    },
    forfeit: async (id) => {
      forfeited.push(id)
    },
    recordAttempt: async (id, refusal) => {
      attempts.push({ id, refusal })
    },
    paidToday: async () => 0,
    owed: async () => owed || outstanding.reduce((sum, o) => sum + o.lamports, 0),
    /**
     * What is still owed after this pass, past the attempt threshold (`#541`).
     *
     * Derived from the same rows and the attempts this pass recorded, so the
     * fake answers what the table would: the pass counts *after* deferring, and
     * an obligation that crosses the threshold on this pass is meant to be in
     * the number this pass reports.
     */
    stuck: async (minAttempts) =>
      outstanding
        .filter((obligation) => !paid.some((row) => row.id === obligation.id))
        .filter((obligation) => !forfeited.includes(obligation.id))
        .map((obligation) => ({
          id: obligation.id,
          agentId: obligation.agentId,
          lamports: obligation.lamports,
          address: obligation.address,
          attempts: obligation.attempts + attempts.filter((row) => row.id === obligation.id).length,
          lastRefusal: attempts.findLast((row) => row.id === obligation.id)?.refusal ?? null,
          lastAttemptAt: null,
          owedSince: '2026-08-07T15:52:00.000Z',
        }))
        .filter((obligation) => obligation.attempts >= minAttempts),
  }

  return { desk, attempts, paid, forfeited }
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

  /**
   * The debt outlives the citizen: the address is on the row, so the wallet is
   * still reachable after the account is gone.
   */
  it('still pays a citizen that has erased itself, into the wallet on the row', async () => {
    const { desk, paid } = fakeDesk([anObligation({ agentId: null, erased: true })])

    await runPayouts(deps({ desk }))

    expect(paid).toEqual([{ id: 'an-obligation', signature: 'a-signature' }])
  })

  /**
   * The one amount written off: too small for the chain to deliver, and nobody
   * left to fund the address or earn the rest.
   */
  it('forfeits an accrual below the chain minimum once its citizen has gone', async () => {
    const { desk, forfeited, attempts } = fakeDesk([
      anObligation({ lamports: 1000, agentId: null, erased: true }),
    ])
    const chain = fakeChain({ funded: async () => false })

    const outcome = await runPayouts(deps({ desk, chain }))

    expect(forfeited).toEqual(['an-obligation'])
    expect(outcome.forfeited).toBe(1)
    // Written off rather than deferred: a deferred row would be retried for ever.
    expect(attempts).toEqual([])
  })

  /** A living citizen's accrual waits: it may clear, or the citizen may fund the address. */
  it('does not forfeit the same accrual while its citizen is still here', async () => {
    const { desk, forfeited, attempts } = fakeDesk([anObligation({ lamports: 1000 })])
    const chain = fakeChain({ funded: async () => false })

    await runPayouts(deps({ desk, chain }))

    expect(forfeited).toEqual([])
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

  /**
   * The float, on a pass with nothing to pay (`#536`).
   *
   * The defect: `runPayouts` returned `floatShort: false` on an empty pass
   * **without asking the chain anything**, under a comment promising the
   * opposite — *a float that has run out is worth knowing about before the next
   * report is accepted rather than after*. Nothing owed is the state the Colony
   * spends most of its time in, so the one signal the design calls loud was
   * structurally silent: measured 2026-08-08, 29 consecutive passes reported a
   * healthy float about a wallet none of them had looked at.
   */
  describe('a pass with nothing owed', () => {
    it('reads the balance anyway and reports it', async () => {
      const { desk } = fakeDesk([])
      let asked = 0
      const chain = fakeChain({
        balance: async () => {
          asked += 1
          return LAMPORTS_PER_SOL
        },
      })

      const outcome = await runPayouts(deps({ desk, chain }))

      expect(asked).toBe(1)
      expect(outcome.heldLamports).toBe(LAMPORTS_PER_SOL)
      expect(outcome.considered).toBe(0)
    })

    it('says the wallet can pay nothing at all, before a citizen finds out', async () => {
      const { desk } = fakeDesk([])
      const chain = fakeChain({ balance: async () => FEE_RESERVE_LAMPORTS })

      const outcome = await runPayouts(deps({ desk, chain }))

      expect(outcome.floatEmpty).toBe(true)
      // And not `floatShort`, which would be a claim about a debt that does not
      // exist. Nothing is owed, so the wallet is not short of it.
      expect(outcome.floatShort).toBe(false)
    })

    it('is quiet about a float that can still pay', async () => {
      const { desk } = fakeDesk([])
      const chain = fakeChain({ balance: async () => FEE_RESERVE_LAMPORTS + 1 })

      const outcome = await runPayouts(deps({ desk, chain }))

      expect(outcome.floatEmpty).toBe(false)
      expect(outcome.floatShort).toBe(false)
    })
  })

  it('reports the balance on a pass that did pay, not only on an empty one', async () => {
    const { desk } = fakeDesk([anObligation()])
    const chain = fakeChain({ balance: async () => LAMPORTS_PER_SOL * 3 })

    const outcome = await runPayouts(deps({ desk, chain }))

    expect(outcome.heldLamports).toBe(LAMPORTS_PER_SOL * 3)
    expect(outcome.floatEmpty).toBe(false)
  })

  /** A deployment that cannot pay has said so at startup; it must not throw hourly. */
  it('does nothing, quietly, without a wallet, a chain or ceilings', async () => {
    const { desk } = fakeDesk([anObligation()])

    for (const missing of [{ wallet: undefined }, { chain: undefined }, { ceilings: undefined }]) {
      const outcome = await runPayouts(deps({ desk, ...missing }))
      // `heldLamports` is null rather than zero: a deployment with no wallet
      // holds no balance, which is not the same fact as a wallet holding
      // nothing (`#536`).
      expect(outcome).toMatchObject({
        considered: 0,
        paid: 0,
        heldLamports: null,
        floatEmpty: false,
      })
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

  /**
   * **A payout that keeps failing is a number nobody reads** (`#541`).
   *
   * `attempts` and `last_refusal` have been on the row since `#505` and nothing
   * read either, so an obligation on its fortieth attempt looked exactly like
   * one on its first. The float alert covers the Colony being unable to pay; it
   * says nothing about one citizen being unpayable while everything else goes
   * out normally.
   */
  describe('what has been retried too often', () => {
    it('is counted in the pass, beside floatShort', async () => {
      const { desk } = fakeDesk([
        anObligation({ id: 'stuck', address: null, attempts: PAYOUT_STUCK_AFTER_ATTEMPTS }),
        anObligation({ id: 'fresh', address: null, attempts: 0 }),
      ])

      const outcome = await runPayouts(deps({ desk }))

      expect(outcome.stuck).toBe(1)
    })

    /**
     * Counted after the pass rather than before it: the obligation that crosses
     * the threshold on this pass is the one worth naming on this pass.
     */
    it('counts the attempt this pass just made', async () => {
      const { desk } = fakeDesk([
        anObligation({
          id: 'about-to-stick',
          address: null,
          attempts: PAYOUT_STUCK_AFTER_ATTEMPTS - 1,
        }),
      ])

      expect((await runPayouts(deps({ desk }))).stuck).toBe(1)
    })

    it('is zero when everything owed is being paid', async () => {
      const { desk } = fakeDesk([anObligation()])

      const outcome = await runPayouts(deps({ desk }))

      expect(outcome.paid).toBe(1)
      expect(outcome.stuck).toBe(0)
    })

    /**
     * **The rejection case, and it is the whole of `#132`'s rule.** Nothing is
     * abandoned at this count or at any other: the amount is still owed, still
     * attempted, and the only thing crossing the threshold changes is that
     * somebody is told.
     */
    it('changes nothing about what is paid', async () => {
      const overdue = anObligation({ id: 'overdue', attempts: PAYOUT_STUCK_AFTER_ATTEMPTS * 10 })
      const { desk, paid, forfeited } = fakeDesk([overdue])

      const outcome = await runPayouts(deps({ desk }))

      expect(paid.map((row) => row.id)).toEqual(['overdue'])
      expect(forfeited).toEqual([])
      expect(outcome.lamportsPaid).toBe(overdue.lamports)
    })
  })
})

/**
 * `#764`. A Cloudflare 522 in front of the RPC provider used to throw out of the
 * pass, so `POST /v1/payouts/run` answered 500 with a stack and the journal lost
 * the pass entirely. The endpoint being briefly unavailable is a state of the
 * world, and these are the tests that it is written down as one.
 */
describe('a payout pass that cannot reach the chain', () => {
  const unreachable = (): never => {
    throw new ChainUnreachableError('getBalance', 'answered 522')
  }

  it('reports it instead of throwing, and pays nobody', async () => {
    const { desk, attempts, paid } = fakeDesk([anObligation()])

    const outcome = await runPayouts(
      deps({ desk, chain: fakeChain({ balance: async () => unreachable() }) }),
    )

    expect(outcome.chainUnreachable).toBe(true)
    expect(outcome.paid).toBe(0)
    // Nothing is recorded against the citizen: the Colony did not decide
    // anything about this obligation, it failed to ask.
    expect(attempts).toEqual([])
    expect(paid).toEqual([])
  })

  it('claims nothing about the float it did not read', async () => {
    const { desk } = fakeDesk([anObligation()])

    const outcome = await runPayouts(
      deps({ desk, chain: fakeChain({ balance: async () => unreachable() }) }),
    )

    // `heldLamports: null` and not `0` — the same distinction `#536` drew
    // between a deployment with no wallet and a wallet holding nothing.
    expect(outcome.heldLamports).toBeNull()
    expect(outcome.floatShort).toBe(false)
    expect(outcome.floatEmpty).toBe(false)
  })

  it('reports it on a pass with nothing outstanding too', async () => {
    const { desk } = fakeDesk([])

    const outcome = await runPayouts(
      deps({ desk, chain: fakeChain({ balance: async () => unreachable() }) }),
    )

    expect(outcome).toMatchObject({ chainUnreachable: true, considered: 0, heldLamports: null })
  })

  /**
   * **The reason the loop breaks rather than deferring.** Every remaining
   * obligation would ask the same endpoint and get the same nothing, and
   * attempts are counted — deferring them all would eventually report citizens
   * as stuck (`#541`) because the Colony's own network blinked.
   */
  it('ends the pass rather than recording an attempt against everybody', async () => {
    const { desk, attempts } = fakeDesk([
      anObligation({ id: 'first' }),
      anObligation({ id: 'second' }),
      anObligation({ id: 'third' }),
    ])

    const outcome = await runPayouts(
      deps({ desk, chain: fakeChain({ funded: async () => unreachable() }) }),
    )

    expect(outcome.chainUnreachable).toBe(true)
    expect(attempts).toEqual([])
  })

  it('keeps what it managed to pay before the endpoint went away', async () => {
    const { desk, paid } = fakeDesk([anObligation({ id: 'first' }), anObligation({ id: 'second' })])
    let asked = 0

    const outcome = await runPayouts(
      deps({
        desk,
        chain: fakeChain({
          funded: async () => {
            asked += 1
            return asked > 1 ? unreachable() : true
          },
        }),
      }),
    )

    expect(outcome.chainUnreachable).toBe(true)
    expect(outcome.paid).toBe(1)
    expect(paid.map((row) => row.id)).toEqual(['first'])
  })

  /**
   * The rejection case: an error that is *not* the endpoint being unreachable
   * still comes out. A pass that swallowed everything would turn a real defect
   * into a quiet line saying the world was flaky.
   */
  it('does not swallow an error that is the Colony’s own', async () => {
    const { desk } = fakeDesk([anObligation()])

    await expect(
      runPayouts(
        deps({
          desk,
          chain: fakeChain({
            balance: async () => {
              throw new Error('a bug in this repository')
            },
          }),
        }),
      ),
    ).rejects.toThrow('a bug in this repository')
  })
})
