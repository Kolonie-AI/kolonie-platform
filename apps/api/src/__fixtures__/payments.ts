import type { AgentId } from '@kolonie-ai/core'
import type { ColonyPaymentRecord } from '@kolonie-ai/db'
import type { PaymentDesk } from '../payments.js'

/** The address every fixture payment arrived at. */
export const FAKE_COLONY_WALLET = 'CoLoNyWaLLeTaDdReSs'

/**
 * What the Colony's wallet has received, in memory (`#760`).
 *
 * **Empty by default and that is the interesting case**: a sponsor asking about
 * a signature the Colony has not recorded is the ordinary answer minutes after a
 * transfer, and it is the one `kolonie.quests.payment` must render without
 * implying the money is gone.
 *
 * The write half is deliberately not here. Recording an arrival is what the
 * webhook and the reconciliation do, and `payments.test.ts` drives those through
 * a desk of its own that counts what it was asked to record; this one exists so
 * the read surface has something to read.
 */
export interface FakePaymentDesk extends PaymentDesk {
  /** Put an arrival on the desk, as a delivery that got through would. */
  readonly hold: (record: Partial<ColonyPaymentRecord>) => ColonyPaymentRecord
}

export function fakePaymentDesk(): FakePaymentDesk {
  const bySignature = new Map<string, ColonyPaymentRecord>()

  return {
    wallet: FAKE_COLONY_WALLET,
    record: async () => ({ outcome: 'quarantined', quarantine: 'unverified-sender' }),
    recorded: async (signature) => bySignature.has(signature),
    bySignature: async (signature) => bySignature.get(signature),
    quarantined: async () => [...bySignature.values()].filter((row) => row.quarantine !== null),
    from: async (agentId) => [...bySignature.values()].filter((row) => row.agentId === agentId),
    expireUnpaid: async () => [],
    hold: (record) => {
      const held: ColonyPaymentRecord = {
        signature: 'a-signature',
        sender: 'a-verified-wallet',
        agentId: null,
        lamports: 1_400_000,
        observedAt: '2026-08-07T15:52:00.000Z',
        // Attributed to nobody unless the caller says otherwise, which is what
        // the check constraint makes of a row that carries no `agentId`.
        attributedAt: null,
        quarantine: null,
        resolvedAt: null,
        resolution: null,
        ...record,
      }
      bySignature.set(held.signature, held)
      return held
    },
  }
}

/** An arrival that became a citizen's money, which is the ordinary shape. */
export const anAttributedPayment = (
  agentId: AgentId,
  overrides: Partial<ColonyPaymentRecord> = {},
): Partial<ColonyPaymentRecord> => ({
  agentId,
  attributedAt: '2026-08-07T15:52:04.000Z',
  ...overrides,
})
