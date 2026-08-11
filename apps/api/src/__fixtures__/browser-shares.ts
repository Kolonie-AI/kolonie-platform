import { randomUUID } from 'node:crypto'
import {
  BROWSER_SHARE_LIVE_MINUTES,
  BROWSER_SHARE_OFFER_HOURS,
  type AgentId,
  type HumanId,
  type ShareCloseReason,
  type ShareSummary,
} from '@kolonie-ai/core'
import type { AcceptShareOutcome, OfferShareCommand, OfferShareOutcome } from '@kolonie-ai/db'
import type { ShareDesk } from '../browser-shares.js'

/**
 * The third operator channel, in memory (`#737`).
 *
 * It holds the rules storage holds and nothing else: one open share per agent,
 * the two prerequisites, the two window lengths, and a close where the first
 * reason wins. **What it deliberately has no field for is a frame** — the same
 * property `packages/db/src/storage/browser-shares.ts` asserts of the real one.
 *
 * A test says who may offer through {@link FakeShareStore.allow}, because the
 * two prerequisites are facts about the citizen rather than about the channel,
 * and a fixture that granted them silently would quietly make every test here a
 * test of the happy path.
 */
export interface FakeShareStore {
  /**
   * Give a citizen what an offer needs. Both by default; name one as `false` to
   * withhold it, which is how the two refusals are reached.
   */
  readonly allow: (agentId: AgentId, what?: { operator?: boolean; skill?: boolean }) => void
  /** Everything ever offered, so a test can assert what was and was not kept. */
  readonly all: () => readonly ShareSummary[]
}

type Held = {
  readonly id: string
  readonly agentId: AgentId
  summary: ShareSummary
}

export function fakeShares(): ShareDesk & FakeShareStore {
  const shares: Held[] = []
  const operators = new Set<AgentId>()
  const rungs = new Set<AgentId>()

  const inMinutes = (minutes: number): string =>
    new Date(Date.now() + minutes * 60_000).toISOString()

  const held = (shareId: string): Held | undefined =>
    shares.find((candidate) => candidate.id === shareId)

  const open = (agentId: AgentId): Held | undefined =>
    shares.find(
      (candidate) => candidate.agentId === agentId && candidate.summary.state !== 'closed',
    )

  const mine = (agentId: AgentId): Held | undefined =>
    shares.filter((candidate) => candidate.agentId === agentId).at(-1)

  return {
    offer: async (command: OfferShareCommand): Promise<OfferShareOutcome> => {
      if (open(command.agentId) !== undefined) {
        return { outcome: 'refused', reason: 'already-open' }
      }
      if (!operators.has(command.agentId)) return { outcome: 'refused', reason: 'no-operator' }
      if (!rungs.has(command.agentId)) return { outcome: 'refused', reason: 'no-skill' }

      const id = randomUUID()
      const expiresAt = inMinutes(BROWSER_SHARE_OFFER_HOURS * 60)
      shares.push({
        id,
        agentId: command.agentId,
        summary: {
          id,
          state: 'offered',
          targetId: command.targetId,
          purpose: command.purpose,
          provider: command.provider ?? null,
          step: command.step ?? null,
          offeredAt: new Date().toISOString(),
          acceptedAt: null,
          closedAt: null,
          closedFor: null,
          expiresAt,
        },
      })

      return { outcome: 'offered', share: { id, token: `token-${id}`, expiresAt } }
    },
    live: async (agentId: AgentId) => open(agentId)?.summary ?? null,
    latest: async (agentId: AgentId) => mine(agentId)?.summary ?? null,
    /**
     * Open however old, closed only inside the window — the one rule this fake
     * has to reproduce faithfully, because it is the whole reason the digest
     * asks a different question from the status tool.
     */
    forWakeup: async (agentId: AgentId, since: string) => {
      const last = mine(agentId)?.summary
      if (last === undefined) return null
      if (last.state !== 'closed') return last
      return last.closedAt !== null && last.closedAt >= since ? last : null
    },
    forToken: async (token: string) => {
      const found = shares.find((candidate) => `token-${candidate.id}` === token)
      if (found === undefined || found.summary.state === 'closed') return null
      return {
        id: found.id,
        agentId: found.agentId,
        targetId: found.summary.targetId,
        acceptedAt: found.summary.acceptedAt,
        expiresAt: found.summary.expiresAt,
      }
    },
    accept: async (shareId: string, _humanId: HumanId): Promise<AcceptShareOutcome> => {
      const found = held(shareId)
      if (found === undefined || found.summary.state === 'closed') {
        return { outcome: 'refused', reason: 'unknown' }
      }
      if (found.summary.state === 'live') return { outcome: 'refused', reason: 'taken' }

      const acceptedAt = new Date().toISOString()
      const expiresAt = inMinutes(BROWSER_SHARE_LIVE_MINUTES)
      found.summary = { ...found.summary, state: 'live', acceptedAt, expiresAt }

      return {
        outcome: 'accepted',
        share: {
          id: found.id,
          agentId: found.agentId,
          targetId: found.summary.targetId,
          acceptedAt,
          expiresAt,
        },
      }
    },
    close: async (shareId: string, reason: ShareCloseReason) => {
      const found = held(shareId)
      if (found === undefined || found.summary.state === 'closed') return false

      found.summary = {
        ...found.summary,
        state: 'closed',
        closedAt: new Date().toISOString(),
        closedFor: reason,
      }
      return true
    },
    waitingFor: async (_humanId: HumanId) =>
      shares
        .filter((candidate) => candidate.summary.state === 'offered')
        .map((candidate) => ({
          shareId: candidate.id,
          agentName: candidate.agentId,
          purpose: candidate.summary.purpose,
          provider: candidate.summary.provider,
          step: candidate.summary.step,
          offeredAt: candidate.summary.offeredAt,
          expiresAt: candidate.summary.expiresAt,
        })),
    allow: (agentId, what) => {
      if (what?.operator !== false) operators.add(agentId)
      if (what?.skill !== false) rungs.add(agentId)
    },
    all: () => shares.map((candidate) => candidate.summary),
  }
}
