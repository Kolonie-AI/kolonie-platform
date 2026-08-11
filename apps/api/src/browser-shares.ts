import {
  acceptShare,
  closeShare,
  latestShare,
  liveShare,
  offerShare,
  shareForToken,
  sharesWaitingFor,
  type AcceptShareOutcome,
  type Database,
  type OfferShareOutcome,
  type ShareForRelay,
  type WaitingShare,
} from '@kolonie-ai/db'
import type { AgentId, HumanId, ShareCloseReason, ShareSummary } from '@kolonie-ai/core'

/**
 * The browser share as the API sees it (`#736`): a port, so the two sockets and
 * the tools over them are testable without a PostgreSQL.
 *
 * The same arrangement `DropStore` in `operator-drops.ts` uses, and for the same
 * reason — every rule about *who may* lives in `packages/db/src/storage`, next to
 * the statement that enforces it, and this interface is only the shape a route
 * calls it through.
 */
export interface ShareDesk {
  /** The agent offers its tab. Refused while it already has one open. */
  readonly offer: (command: { agentId: AgentId; targetId: string }) => Promise<OfferShareOutcome>
  /** The share this agent has going, if any. `offered` or `live`. */
  readonly live: (agentId: AgentId) => Promise<ShareSummary | null>
  /** The last one it had, for reading back how it ended. */
  readonly latest: (agentId: AgentId) => Promise<ShareSummary | null>
  /** The agent's socket presents its token. Null for every closed state. */
  readonly forToken: (token: string) => Promise<ShareForRelay | null>
  /** The operator's window names the share, and its session says who it is. */
  readonly accept: (shareId: string, humanId: HumanId) => Promise<AcceptShareOutcome>
  /** End it. Idempotent — the first reason wins. */
  readonly close: (shareId: string, reason: ShareCloseReason) => Promise<boolean>
  /** Every offer waiting on this person, across every agent they operate. */
  readonly waitingFor: (humanId: HumanId) => Promise<readonly WaitingShare[]>
}

export function databaseShares(db: Database): ShareDesk {
  return {
    offer: (command) => offerShare(db, command),
    live: (agentId) => liveShare(db, agentId),
    latest: (agentId) => latestShare(db, agentId),
    forToken: (token) => shareForToken(db, token),
    accept: (shareId, humanId) => acceptShare(db, shareId, humanId),
    close: (shareId, reason) => closeShare(db, shareId, reason),
    waitingFor: (humanId) => sharesWaitingFor(db, humanId),
  }
}
