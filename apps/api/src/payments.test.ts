import { describe, expect, it } from 'vitest'
import { LAMPORTS_PER_SOL, type ObservedPayment, type TransferClaim } from '@kolonie-ai/core'
import type { ColonyPaymentOutcome, ColonyPaymentRecord } from '@kolonie-ai/db'
import {
  readPaymentDelivery,
  reconcilePayments,
  settlePaymentDelivery,
  type PaymentDependencies,
  type PaymentDesk,
  type PaymentWatcher,
} from './payments.js'

const COLONY = 'CoLoNyWaLLeTaDdReSs'

const aPayment = (overrides: Partial<ObservedPayment> = {}): ObservedPayment => ({
  signature: 'a-signature',
  sender: 'a-verified-wallet',
  recipient: COLONY,
  lamports: LAMPORTS_PER_SOL / 100,
  commitment: 'finalized',
  ...overrides,
})

/** A desk that answers what it is told to and remembers what it was asked. */
function fakeDesk(
  outcomes: readonly ColonyPaymentOutcome[] = [
    { outcome: 'attributed', agentId: 'an-agent' as never, lamports: 1 },
  ],
): PaymentDesk & { readonly recordedPayments: ObservedPayment[]; seen: Set<string> } {
  const recordedPayments: ObservedPayment[] = []
  const seen = new Set<string>()
  let index = 0

  return {
    wallet: COLONY,
    recordedPayments,
    seen,
    record: async (payment) => {
      recordedPayments.push(payment)
      return outcomes[Math.min(index++, outcomes.length - 1)] as ColonyPaymentOutcome
    },
    recorded: async (signature) => seen.has(signature),
    quarantined: async (): Promise<readonly ColonyPaymentRecord[]> => [],
    from: async (): Promise<readonly ColonyPaymentRecord[]> => [],
  }
}

const watcherOf = (payments: readonly ObservedPayment[]): PaymentWatcher => ({
  paymentsAt: async () => payments,
  paymentsIn: async () => payments,
})

const claim = (address = COLONY): TransferClaim => ({ signature: 'a-signature', address })

/**
 * D-106 (`#503`). The properties that matter are the ones a webhook cannot be
 * trusted with: that a delivery decides nothing, that a delivery naming somebody
 * else's address writes nothing, and that the reconciliation alone is enough.
 */
describe('a payment delivery', () => {
  it('records what the chain says, not what the delivery says', async () => {
    const desk = fakeDesk()
    const deps: PaymentDependencies = { desk, watcher: watcherOf([aPayment()]) }

    const { outcome } = await readPaymentDelivery(deps, [claim()])

    expect(outcome.attributed).toBe(1)
    // The amount and the sender came from the watcher rather than the claim,
    // which carries neither.
    expect(desk.recordedPayments[0]?.lamports).toBe(LAMPORTS_PER_SOL / 100)
    expect(desk.recordedPayments[0]?.sender).toBe('a-verified-wallet')
  })

  /**
   * Whoever holds the webhook secret chooses which addresses a delivery names. A
   * row per named stranger would let the sender fill the table.
   */
  it('ignores a claim that does not name the Colony wallet, and writes nothing', async () => {
    const desk = fakeDesk()
    const deps: PaymentDependencies = { desk, watcher: watcherOf([aPayment()]) }

    const { outcome } = await readPaymentDelivery(deps, [claim('somebody-elses-wallet')])

    expect(outcome).toMatchObject({ claims: 1, ignored: 1, attributed: 0 })
    expect(desk.recordedPayments).toHaveLength(0)
  })

  /** Helius fires before the cluster finalizes, every time. That is not a fault. */
  it('leaves a claim the chain has not finalized to be asked about again', async () => {
    const deps: PaymentDependencies = { desk: fakeDesk(), watcher: watcherOf([]) }

    const { outcome, pending } = await readPaymentDelivery(deps, [claim()])

    expect(outcome.unverified).toBe(1)
    expect(pending).toHaveLength(1)
  })

  it('leaves a claim the endpoint could not answer about to be asked about again', async () => {
    const deps: PaymentDependencies = {
      desk: fakeDesk(),
      watcher: {
        paymentsAt: async () => [],
        paymentsIn: async () => {
          throw new Error('the endpoint is down')
        },
      },
    }

    const { outcome, pending } = await readPaymentDelivery(deps, [claim()])

    expect(outcome.unverified).toBe(1)
    expect(pending).toHaveLength(1)
  })

  /** A deployment with no RPC endpoint cannot verify anything, ever. */
  it('schedules nothing when there is nothing that could ever verify it', async () => {
    const { outcome, pending } = await readPaymentDelivery({ desk: fakeDesk() }, [claim()])

    expect(outcome.unverified).toBe(1)
    expect(pending).toHaveLength(0)
  })

  it('stops asking as soon as the chain answers', async () => {
    const desk = fakeDesk()
    let asked = 0
    const deps: PaymentDependencies = {
      desk,
      watcher: {
        paymentsAt: async () => [],
        paymentsIn: async () => (++asked >= 2 ? [aPayment()] : []),
      },
    }

    const settled = await settlePaymentDelivery(deps, [claim()], {
      waits: [1, 1, 1, 1],
      sleep: async () => {},
    })

    expect(settled.attributed).toBe(1)
    expect(asked).toBe(2)
  })
})

describe('the reconciliation over the Colony wallet', () => {
  /**
   * `kolonie-infra#73` is a webhook that was registered, authenticated and never
   * observed delivering. This is the path that has to work without it.
   */
  it('attributes an arrival the webhook never mentioned, and says it recovered it', async () => {
    const desk = fakeDesk()
    const deps: PaymentDependencies = { desk, watcher: watcherOf([aPayment()]) }

    expect(await reconcilePayments(deps)).toEqual({
      attributed: 1,
      quarantined: 0,
      recovered: 1,
      failed: 0,
    })
  })

  /** The number that says whether the live path is working at all. */
  it('does not count an arrival the webhook already recorded as recovered', async () => {
    const desk = fakeDesk()
    desk.seen.add('a-signature')
    const deps: PaymentDependencies = { desk, watcher: watcherOf([aPayment()]) }

    expect(await reconcilePayments(deps)).toMatchObject({ attributed: 1, recovered: 0 })
  })

  it('counts a quarantined arrival, because money the Colony is holding is not nothing', async () => {
    const desk = fakeDesk([{ outcome: 'quarantined', quarantine: 'unverified-sender' }])
    const deps: PaymentDependencies = { desk, watcher: watcherOf([aPayment()]) }

    expect(await reconcilePayments(deps)).toMatchObject({ attributed: 0, quarantined: 1 })
  })

  /**
   * A pass that reported a clean run it never had would be worse than one that
   * failed: the whole point of this path is that somebody can believe it.
   */
  it('reports a failure rather than an empty pass when the endpoint is down', async () => {
    const deps: PaymentDependencies = {
      desk: fakeDesk(),
      watcher: {
        paymentsAt: async () => {
          throw new Error('the endpoint is down')
        },
        paymentsIn: async () => [],
      },
    }

    expect(await reconcilePayments(deps)).toMatchObject({ failed: 1 })
  })

  it('reports zeros without a watcher rather than throwing on a schedule', async () => {
    expect(await reconcilePayments({ desk: fakeDesk() })).toEqual({
      attributed: 0,
      quarantined: 0,
      recovered: 0,
      failed: 0,
    })
  })
})
