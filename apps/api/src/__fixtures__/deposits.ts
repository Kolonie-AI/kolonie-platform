import { randomUUID } from 'node:crypto'
import {
  SPL_TOKEN_PROGRAM,
  USDC_MINT,
  creditsFromUsdc,
  depositRejection,
  type AgentId,
  type Deposit,
  type ObservedTransfer,
} from '@kolonie-ai/core'
import type { DepositDependencies, DepositDesk } from '../deposits.js'

/**
 * The deposit desk, in memory.
 *
 * **It reproduces the two rules the routes rely on**: one address per identity,
 * and one credit per signature. Whether Postgres enforces them is asserted in
 * `packages/db` against a real one; a fake that skipped them would let the API
 * tests pass while a redelivered webhook credited twice.
 */
export function fakeDeposits(): DepositDesk & {
  readonly seen: () => readonly Deposit[]
} {
  const addresses = new Map<string, string>()
  const recorded = new Map<string, Deposit>()

  return {
    seen: () => [...recorded.values()],

    async address(agentId: AgentId) {
      const held = addresses.get(agentId) ?? `address-${randomUUID().slice(0, 8)}`
      addresses.set(agentId, held)
      return { address: held }
    },

    async history(agentId: AgentId) {
      const own = addresses.get(agentId)
      return [...recorded.values()].filter(() => own !== undefined)
    },

    async record(transfer: ObservedTransfer) {
      const rejection = depositRejection(transfer)
      if (rejection === 'not-final') return { outcome: 'not-final' as const }
      if (recorded.has(transfer.signature)) return { outcome: 'already-recorded' as const }

      const { credits, remainder } = creditsFromUsdc(transfer.baseUnits)
      const owned = [...addresses.values()].includes(transfer.address)
      const refusal = owned ? rejection : 'unknown-address'

      recorded.set(transfer.signature, {
        signature: transfer.signature,
        baseUnits: transfer.baseUnits,
        credits: refusal === undefined ? credits : 0,
        remainder: refusal === undefined ? remainder : transfer.baseUnits,
        observedAt: new Date().toISOString(),
        creditedAt: refusal === undefined ? new Date().toISOString() : null,
        rejection: refusal ?? null,
      })

      return refusal === undefined
        ? { outcome: 'credited' as const, credits, remainder }
        : { outcome: 'refused' as const, rejection: refusal }
    },

    async watched() {
      return [...addresses.values()]
    },

    async recorded(signature: string) {
      return recorded.has(signature)
    },
  }
}

/** A finalized USDC transfer, which is the only shape that credits anything. */
export const aTransfer = (overrides: Partial<ObservedTransfer> = {}): ObservedTransfer => ({
  signature: randomUUID(),
  address: 'unknown',
  mint: USDC_MINT,
  tokenProgram: SPL_TOKEN_PROGRAM,
  baseUnits: 1_000_000,
  commitment: 'finalized',
  ...overrides,
})

/** The dependency object, wired with a secret so the webhook is mounted. */
export function fakeDepositDependencies(
  desk: DepositDesk,
  webhookSecret = 'a-webhook-secret',
): DepositDependencies {
  return { desk, webhookSecret }
}
