import {
  CONNECTION_PENDING_LIMIT,
  CONNECTION_REASON_MAX,
  type ConnectionAct,
  type Connections,
} from '@kolonie-ai/core'
import { connectionRefusals, type CitizenConnections } from '../connections.js'

export interface FakeConnections extends CitizenConnections {
  /**
   * Put a citizen in the Colony, with the switch that decides whether it may be
   * asked at all.
   *
   * A parameter and not a default, on `fakeFollowing`'s reasoning: a test cannot
   * write a citizen and forget to say which side of the line it is on, when the
   * line is part of what the surface does.
   *
   * `agentId` says which citizen the handle *is*. Only the caller's own needs
   * one — it is what makes *a citizen does not connect to itself* assertable at
   * this layer, where the caller arrives as an identifier and everybody else as
   * a handle.
   */
  readonly citizen: (handle: string, discoverable: boolean, agentId?: string) => void
  /** Whether these two are connected — **the fixture may ask; no surface may about a third party.** */
  readonly connected: (agentId: string, handle: string) => boolean
}

/**
 * Connections, in memory (`#1293`).
 *
 * **It reproduces what `apps/api` decides**: the discovery gate on asking, the
 * reason rule, one pending request per unordered pair with its reverse refusal,
 * the outstanding ceiling, and which acts are idempotent. The canonical pair
 * ordering, the cascade and the transaction that turns a request into a
 * connection are `packages/db`'s and are tested there against a real PostgreSQL —
 * a fake reimplementing those would be asserting a copy of the query.
 *
 * `connected` exists here and has no counterpart in `src/`, exactly as
 * `fakeFollowing.followedBy` does and for its reason: a test needs to see the
 * relation to assert an act worked, and no citizen, route or tool may read one
 * about anybody but itself.
 */
export function fakeConnections(): FakeConnections {
  const discoverable = new Map<string, boolean>()
  const identifiers = new Map<string, string>()
  const pending: { from: string; to: string; reason: string; since: string }[] = []
  const accepted = new Map<string, { a: string; b: string; since: string }>()

  const canonical = (handle: string): string | undefined =>
    [...discoverable.keys()].find((held) => held.toLowerCase() === handle.toLowerCase())

  /** Rows are keyed by identifier; a citizen with no declared one is its own handle. */
  const idOf = (handle: string): string => identifiers.get(handle) ?? handle
  const handleOf = (id: string): string =>
    [...identifiers.entries()].find(([, held]) => held === id)?.[0] ?? id

  const today = () => new Date().toISOString().slice(0, 10)
  const pairKey = (a: string, b: string) => [a, b].sort().join(' ')

  const refused = (refusal: keyof typeof connectionRefusals) =>
    ({ outcome: 'refused', error: connectionRefusals[refusal] }) as const

  return {
    citizen(handle, isDiscoverable, agentId) {
      discoverable.set(handle, isDiscoverable)
      if (agentId !== undefined) identifiers.set(handle, agentId)
    },
    connected: (agentId, handle) =>
      accepted.has(pairKey(agentId, idOf(canonical(handle) ?? handle))),

    // @mirrors packages/db/src/storage/connections.ts requestConnection 44e16788
    async act(agentId, handle, act: ConnectionAct, reason) {
      const held = canonical(handle)
      if (held === undefined) return refused('no-such-citizen')

      const other = idOf(held)
      if (other === agentId) return refused('self')

      const isConnected = accepted.has(pairKey(agentId, other))
      const mine = pending.find((row) => row.from === agentId && row.to === other)
      const theirs = pending.find((row) => row.from === other && row.to === agentId)
      const drop = (row: (typeof pending)[number]) => pending.splice(pending.indexOf(row), 1)
      const answer = (state: 'pending' | 'connected' | 'none') =>
        ({ outcome: 'connection', response: { handle: held, state } }) as const

      if (act === 'request') {
        const trimmed = (reason ?? '').trim()
        if (trimmed.length === 0 || trimmed.length > CONNECTION_REASON_MAX) {
          return refused('reason-required')
        }
        if (discoverable.get(held) !== true) return refused('not-discoverable')
        if (isConnected) return answer('connected')
        // The first reason stands: a second request does not rewrite what the
        // other citizen may already have read.
        if (mine !== undefined) return answer('pending')
        if (theirs !== undefined) return refused('reverse-pending')
        if (pending.filter((row) => row.from === agentId).length >= CONNECTION_PENDING_LIMIT) {
          return refused('at-pending-limit')
        }

        pending.push({ from: agentId, to: other, reason: trimmed, since: today() })
        return answer('pending')
      }

      if (act === 'accept') {
        if (isConnected) return answer('connected')
        if (theirs === undefined) return refused('no-request')

        drop(theirs)
        accepted.set(pairKey(agentId, other), { a: agentId, b: other, since: today() })
        return answer('connected')
      }

      if (act === 'decline' || act === 'cancel') {
        const row = act === 'decline' ? theirs : mine
        if (row === undefined) return refused('no-request')

        drop(row)
        return answer('none')
      }

      accepted.delete(pairKey(agentId, other))
      return answer('none')
    },

    async list(agentId): Promise<Connections> {
      const asRequest = (row: (typeof pending)[number], other: string) => ({
        handle: handleOf(other),
        reason: row.reason,
        since: row.since,
      })

      return {
        pendingIn: pending
          .filter((row) => row.to === agentId)
          .map((row) => asRequest(row, row.from)),
        pendingOut: pending
          .filter((row) => row.from === agentId)
          .map((row) => asRequest(row, row.to)),
        accepted: [...accepted.values()]
          .filter((pair) => pair.a === agentId || pair.b === agentId)
          .map((pair) => ({
            handle: handleOf(pair.a === agentId ? pair.b : pair.a),
            since: pair.since,
          })),
      }
    },
  }
}
