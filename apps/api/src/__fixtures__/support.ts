import { randomUUID } from 'node:crypto'
import {
  SupportTicketIdSchema,
  type AgentId,
  type OpenTicketRequest,
  type SupportTicket,
  type SupportTicketId,
} from '@kolonie-ai/core'
import type { SupportDesk } from '../support.js'

export interface FakeSupportDesk extends SupportDesk {
  /**
   * Put a ticket where the Colony has answered it, which no write path can do.
   *
   * The whole reason `resolution` and `issueUrl` exist is for the citizen to read
   * them, and nothing a citizen calls can set either — so without this the fields
   * would be untestable from this workspace, which is where the rendering lives.
   */
  readonly settle: (
    ticketId: SupportTicketId,
    settlement: Partial<Pick<SupportTicket, 'status' | 'resolution' | 'issueUrl'>>,
  ) => void
}

/**
 * The support desk, in memory.
 *
 * **It reproduces the isolation rule rather than assuming it**, because that rule is
 * the one thing about this table worth getting wrong: `readOwnTicket` here matches on
 * both the id *and* the agent, exactly as the SQL does. A fake that looked up by id
 * alone would let the API tests pass while the real query leaked, which is the
 * failure mode a fixture is supposed to make impossible rather than hide.
 *
 * Whether Postgres actually enforces it is asserted in `packages/db` against a real
 * one. What the API does with the answer is asserted here.
 */
export function fakeSupportDesk(): FakeSupportDesk {
  const tickets = new Map<string, SupportTicket>()

  return {
    openTicket: async ({ agentId, request }) => {
      const now = new Date().toISOString()
      const ticket: SupportTicket = {
        id: SupportTicketIdSchema.parse(randomUUID()),
        agentId,
        kind: request.kind,
        subject: request.subject,
        body: request.body,
        // `open`, and there is no parameter to say otherwise — the same rule the
        // real write path follows.
        status: 'open',
        resolution: null,
        issueUrl: null,
        createdAt: now,
        updatedAt: now,
      }
      tickets.set(String(ticket.id), ticket)
      return ticket
    },

    listOwnTickets: async (agentId) =>
      [...tickets.values()]
        .filter((ticket) => ticket.agentId === agentId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),

    readOwnTicket: async ({ ticketId, agentId }) => {
      const ticket = tickets.get(String(ticketId))
      // Both conditions, like the `where` clause. Not `ticket ?? undefined`.
      return ticket !== undefined && ticket.agentId === agentId ? ticket : undefined
    },

    settle: (ticketId, settlement) => {
      const ticket = tickets.get(String(ticketId))
      if (ticket === undefined) throw new Error('cannot settle a ticket that was never opened')
      tickets.set(String(ticketId), { ...ticket, ...settlement })
    },
  }
}

/** A valid ticket request, so a test only states the part it is about. */
export function aTicketRequest(overrides: Partial<OpenTicketRequest> = {}): OpenTicketRequest {
  return {
    kind: 'defect',
    subject: 'email-roundtrip never delivers the code',
    body:
      'I minted a challenge with kolonie.academy.email.challenge and waited the full hour. ' +
      'Nothing arrived at the address on my profile, and the challenge expired.',
    ...overrides,
  }
}

/** An agent id that belongs to nobody, for the isolation tests. */
export const someoneElse = (): AgentId => randomUUID() as AgentId
