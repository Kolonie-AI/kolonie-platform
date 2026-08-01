import {
  ERASURE_CHALLENGE_TTL_SECONDS,
  ERASURE_CONFIRMATION_PHRASE,
  type AgentId,
  type ErasureChallenge,
  type ErasureReceipt,
} from '@kolonie-ai/core'
import type { EraseAgentResult, ErasureConfirmation } from '@kolonie-ai/db'
import type { ErasureDesk } from '../erasure.js'

export interface FakeErasureDesk extends ErasureDesk {
  /** Every agent id this desk was ever asked to erase, in order. */
  readonly erased: () => AgentId[]
  /** Make the next confirmation fail, however it would have gone. */
  readonly refuseNextConfirmation: () => void
  /** Make the next erasure come back blocked, as an entangled ledger would. */
  readonly blockNextErasure: (reason: string) => void
  /** Whether this agent should be told a signature is required. */
  readonly requireSignature: (agentId: AgentId) => void
}

const RECEIPT: ErasureReceipt = {
  erasedAt: '2026-07-30T12:00:00.000Z',
  coinsBurned: 120,
  reputationDestroyed: 15,
  counts: {
    credentials: 1,
    skills: 3,
    submissions: 4,
    verifications: 4,
    challenges: 2,
    reputationEvents: 3,
    ledgerEntries: 6,
    reports: 2,
    reportFeedback: 1,
    attempts: 2,
    contacts: 9,
    supportTickets: 1,
    taskResets: 0,
    accounts: 0,
  },
  banMarksWritten: 0,
  beyondReach: [
    {
      kind: 'github',
      explanation: 'Gists, commits and pull requests are on your own GitHub account.',
      references: ['https://gist.github.invalid/example/abc'],
    },
    { kind: 'social', explanation: 'A post you published is permanent by design.', references: [] },
    { kind: 'on-chain', explanation: 'A chain does not forget.', references: [] },
    {
      kind: 'wallet-holdings',
      explanation: 'Anything at your own address is yours.',
      references: [],
    },
    { kind: 'backups', explanation: 'Backups hold a copy until they roll.', references: [] },
  ],
}

/**
 * The erasure desk, in memory.
 *
 * **It never actually deletes anything**, and that is the point of the seam:
 * what the transaction does to a real database is asserted in `packages/db`
 * against a real one, and what the *surface* does — the two-step order, the
 * opaque refusal, the receipt reaching the caller — is asserted here. A fixture
 * that tried to reproduce the erasure would be a second implementation of the
 * thing under test.
 *
 * It does hold one rule honestly: the nonce it issues is the only one it
 * accepts, and only from the agent it was issued to. A fake that accepted any
 * nonce would let a test pass while the surface confused two citizens.
 */
export function fakeErasureDesk(): FakeErasureDesk {
  const nonces = new Map<string, AgentId>()
  const erased: AgentId[] = []
  const signatureRequired = new Set<string>()
  let refuseNext = false
  let blockedReason: string | null = null

  return {
    async mintChallenge(agentId): Promise<ErasureChallenge | null> {
      const nonce = `nonce-for-${String(agentId)}-${nonces.size}`
      nonces.set(nonce, agentId)
      return {
        nonce,
        expiresAt: new Date(Date.now() + ERASURE_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
        quote: {
          coins: 120,
          reputation: 15,
          skills: 3,
          writing: { reports: 2, supportTickets: 1 },
        },
        signatureRequired: signatureRequired.has(String(agentId)),
        phrase: ERASURE_CONFIRMATION_PHRASE,
      }
    },

    async confirm(input): Promise<ErasureConfirmation> {
      if (refuseNext) {
        refuseNext = false
        return { outcome: 'refused' }
      }
      // Bound to the agent, exactly as the real one is: a nonce belonging to
      // somebody else is refused rather than accepted because it exists.
      if (nonces.get(input.nonce) !== input.agentId) return { outcome: 'refused' }
      if (input.phrase !== ERASURE_CONFIRMATION_PHRASE) return { outcome: 'refused' }
      if (signatureRequired.has(String(input.agentId)) && input.signature === undefined) {
        return { outcome: 'refused' }
      }
      nonces.delete(input.nonce)
      return { outcome: 'confirmed' }
    },

    async erase(input): Promise<EraseAgentResult> {
      if (blockedReason !== null) {
        const reason = blockedReason
        blockedReason = null
        return { outcome: 'entangled-ledger', reason }
      }
      erased.push(input.agentId)
      return { outcome: 'erased', receipt: RECEIPT }
    },

    erased: () => [...erased],
    refuseNextConfirmation: () => {
      refuseNext = true
    },
    blockNextErasure: (reason) => {
      blockedReason = reason
    },
    requireSignature: (agentId) => {
      signatureRequired.add(String(agentId))
    },
  }
}
