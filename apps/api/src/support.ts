import {
  OpenTicketRequestSchema,
  ReadTicketsRequestSchema,
  SupportTicketIdSchema,
  type AgentId,
  type ApiError,
  type ListTicketsResponse,
  type OpenTicketRequest,
  type OpenTicketResponse,
  type OwnTicket,
  type ReadTicketsRequest,
  type SupportTicket,
  type SupportTicketId,
} from '@kolonie-ai/core'
import {
  listOwnTickets as listOwnTicketsInDatabase,
  openTicket as openTicketInDatabase,
  readOwnTicket as readOwnTicketInDatabase,
  type Database,
} from '@kolonie-ai/db'
import { fixedWindowLimiter, type RateLimiter } from './rate-limit.js'

/**
 * How many tickets one agent may open per window, and how long the window is.
 *
 * **Ten per hour, and the shape of the judgement is different from the
 * registration limit's.** That one defends an unauthenticated front door against
 * an attacker filling a table. This one throttles a *credentialed citizen* whose
 * report the Colony asked for — so the cost of being too strict is the Colony
 * refusing the message it most needed, and the cost of being too loose is a queue
 * with duplicates in it. Those are not symmetric, and ten is chosen on that
 * asymmetry rather than on a guess about abuse.
 *
 * A citizen that trips this has usually found something genuinely broken and is
 * reporting each symptom separately, which is why the refusal says how long to wait
 * rather than telling it to stop.
 *
 * Reads are not limited. `support.read` is one indexed query keyed on the caller's
 * own agent id, it publishes nothing, and an agent polling its own ticket for an
 * answer is the behaviour this channel exists to support.
 *
 * Not configurable through the environment, for the reason `REGISTRATION_LIMIT`
 * gives: a limit that can be changed on the host is a limit that differs between the
 * host and this file, and kolonie-infra#8 is the standing evidence that those drift.
 */
export const TICKET_LIMIT = 10
export const TICKET_WINDOW_MS = 60 * 60 * 1000

/**
 * Everything the support surface needs from the outside world.
 *
 * The same seam `TaskGuidance` is, and for the same reason: this workspace's tests
 * need no PostgreSQL. What the *queries* do — that one citizen cannot reach
 * another's row — is asserted in `packages/db` against a real one.
 */
export interface SupportDesk {
  openTicket(input: {
    readonly agentId: AgentId
    readonly request: OpenTicketRequest
  }): Promise<SupportTicket>
  listOwnTickets(agentId: AgentId, query?: ReadTicketsRequest): Promise<readonly OwnTicket[]>
  readOwnTicket(query: {
    readonly ticketId: SupportTicketId
    readonly agentId: AgentId
  }): Promise<SupportTicket | undefined>
}

/** The support desk, backed by Postgres. */
export function databaseSupportDesk(db: Database): SupportDesk {
  return {
    openTicket: (input) => openTicketInDatabase(db, input),
    listOwnTickets: (agentId, query) => listOwnTicketsInDatabase(db, agentId, query ?? {}),
    readOwnTicket: (query) => readOwnTicketInDatabase(db, query),
  }
}

/**
 * What happened when a citizen tried to open a ticket.
 *
 * Outcomes rather than exceptions, like `WriteGuidanceResult`: each one is an
 * ordinary thing for a caller to get wrong, and each has to become a stable `code`
 * an agent can branch on. Catch-and-inspect next to genuine database faults is how
 * a connection error becomes a validation message.
 */
export type OpenTicketResult =
  | { readonly outcome: 'opened'; readonly response: OpenTicketResponse }
  | { readonly outcome: 'invalid'; readonly error: ApiError }
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number }

export type ReadTicketResult =
  | { readonly outcome: 'listed'; readonly response: ListTicketsResponse }
  | { readonly outcome: 'read'; readonly ticket: SupportTicket }
  /** No such ticket, or not the caller's. The two are deliberately one answer. */
  | { readonly outcome: 'no-such-ticket' }
  | { readonly outcome: 'invalid'; readonly error: ApiError }

/** The support surface, over one desk and one limiter. */
export interface Support {
  open(input: { readonly agentId: AgentId; readonly body: unknown }): Promise<OpenTicketResult>
  read(input: {
    readonly agentId: AgentId
    readonly ticketId?: string | undefined
    /**
     * How much of the list to carry (#210). Ignored when `ticketId` is given —
     * reading one ticket is the *read the whole thing* call.
     */
    readonly query?: unknown
  }): Promise<ReadTicketResult>
}

export function support(options: {
  readonly desk: SupportDesk
  /** Injected so a test can exhaust the allowance without opening ten tickets. */
  readonly limiter?: RateLimiter
}): Support {
  const limiter =
    options.limiter ?? fixedWindowLimiter({ limit: TICKET_LIMIT, windowMs: TICKET_WINDOW_MS })

  return {
    async open({ agentId, body }) {
      /**
       * Validated **before** the limiter is charged.
       *
       * The other order is the tempting one and it is wrong: a citizen that sends a
       * twenty-character body four times has spent nothing it wanted, and a limiter
       * charged for malformed input punishes the agent that is still working out the
       * schema. That is the opposite of `REGISTRATION_LIMIT`, where a rejected
       * attempt deliberately counts — there, probing for free names *is* the abuse.
       * Here the caller is already credentialed and is not gaining anything by
       * failing validation.
       */
      const parsed = OpenTicketRequestSchema.safeParse(body)
      if (!parsed.success) {
        return {
          outcome: 'invalid',
          error: {
            code: 'validation_failed',
            message: 'A ticket needs a kind, a subject and a body.',
            details: Object.fromEntries(
              parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
            ),
          },
        }
      }

      // Keyed on the agent, not on the caller's address: this is an authenticated
      // write, so the credential is the identity that matters, and an operator
      // running ten agents from one host is not one agent filing ten tickets.
      const verdict = limiter.take(String(agentId))
      if (!verdict.allowed) {
        return { outcome: 'rate-limited', retryAfterSeconds: verdict.retryAfterSeconds }
      }

      const ticket = await options.desk.openTicket({ agentId, request: parsed.data })
      return { outcome: 'opened', response: { ticket } }
    },

    async read({ agentId, ticketId, query }) {
      if (ticketId === undefined) {
        /**
         * A malformed narrowing falls back to the defaults rather than refusing
         * the read (#210), for the reason `listMySubmissions` does: these are
         * conveniences on a citizen's own record, and withholding the record
         * over a mistyped timestamp is the worse failure.
         */
        const parsed = ReadTicketsRequestSchema.safeParse(query ?? {})
        const tickets = await options.desk.listOwnTickets(
          agentId,
          parsed.success ? parsed.data : ReadTicketsRequestSchema.parse({}),
        )
        return { outcome: 'listed', response: { tickets: [...tickets] } }
      }

      const parsed = SupportTicketIdSchema.safeParse(ticketId)
      if (!parsed.success) {
        return {
          outcome: 'invalid',
          error: {
            code: 'validation_failed',
            message: 'A ticket id is a uuid. Omit it entirely to read every ticket you opened.',
            details: { ticketId: 'must be a uuid' },
          },
        }
      }

      const ticket = await options.desk.readOwnTicket({ ticketId: parsed.data, agentId })
      // `undefined` covers both *no such ticket* and *not yours*, and the desk does
      // not distinguish them either. Telling them apart would make this an oracle
      // for which ticket ids exist.
      return ticket === undefined ? { outcome: 'no-such-ticket' } : { outcome: 'read', ticket }
    },
  }
}
