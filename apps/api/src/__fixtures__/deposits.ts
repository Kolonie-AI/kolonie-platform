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
import type { DepositDependencies, DepositDesk, DepositWatcher } from '../deposits.js'

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
  /** Make this identity one whose sign-up address nobody has confirmed (`#266`). */
  readonly leaveUnconfirmed: (agentId: AgentId) => void
} {
  const addresses = new Map<string, string>()
  const recorded = new Map<string, Deposit>()
  const unconfirmed = new Set<string>()

  return {
    seen: () => [...recorded.values()],

    leaveUnconfirmed: (agentId) => {
      unconfirmed.add(agentId)
    },

    async address(agentId: AgentId) {
      // `#266`: no address at all before the link is followed, which is where
      // the on-chain half of *confirmed before funded* is enforced.
      if (unconfirmed.has(agentId)) return { outcome: 'address-unconfirmed' as const }

      const held = addresses.get(agentId) ?? `address-${randomUUID().slice(0, 8)}`
      addresses.set(agentId, held)
      return { outcome: 'issued' as const, address: held }
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

/**
 * A watcher with both halves of the port filled in.
 *
 * `transfersIn` arrived with `#321` and every existing test wired a watcher by
 * object literal, so a default that answers *nothing here* keeps a test saying
 * what it is about rather than restating the port.
 */
export function fakeWatcher(overrides: Partial<DepositWatcher> = {}): DepositWatcher {
  return {
    transfersAt: async () => [],
    transfersIn: async () => [],
    ...overrides,
  }
}

/**
 * A chain holding exactly what a test put on it, read by signature (`#321`).
 *
 * The webhook is a trigger: it names a signature and the Colony asks the chain
 * what that signature moved. So a test of the webhook is a test about what the
 * chain answers, and this is the thing that answers.
 */
export function fakeChain(): DepositWatcher & {
  /** Put a transfer on the chain, findable under its own signature. */
  readonly put: (transfer: ObservedTransfer) => void
  /** Make this signature unreadable, as an endpoint that is down would. */
  readonly breakAt: (signature: string) => void
  /** Which signatures were asked about, in order. */
  readonly asked: () => readonly string[]
} {
  const chain = new Map<string, ObservedTransfer[]>()
  const broken = new Set<string>()
  const asked: string[] = []

  return {
    put: (transfer) => {
      chain.set(transfer.signature, [...(chain.get(transfer.signature) ?? []), transfer])
    },
    breakAt: (signature) => {
      broken.add(signature)
    },
    asked: () => asked,

    transfersAt: async () => [],

    transfersIn: async (signature, address) => {
      asked.push(signature)
      if (broken.has(signature)) throw new Error('the endpoint is down')

      // What the chain says landed *at this address*, which is the question the
      // caller asked — a signature can move tokens into several wallets.
      return (chain.get(signature) ?? []).filter((transfer) => transfer.address === address)
    },
  }
}

/** The dependency object, wired with a secret so the webhook is mounted. */
export function fakeDepositDependencies(
  desk: DepositDesk,
  webhookSecret = 'a-webhook-secret',
): DepositDependencies {
  return { desk, webhookSecret }
}
