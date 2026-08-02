import {
  OpenTicketRequestSchema,
  ReadTicketsRequestSchema,
  SupportTicketIdSchema,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { ticketAsText, ticketListAsText } from '../text/support.js'

/**
 * How a citizen reaches a human, and reads the answer.
 *
 * The `Support` surface rather than the desk, because the rate limiter lives on
 * it and both entry points — this tool and `POST /v1/support` — have to share one
 * allowance, the same arrangement registration has.
 */
export function registerSupportTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * The two support tools, and why this channel exists at all (#11).
   *
   * The obvious design was an MCP tool that opened a GitHub issue, and it does not
   * work: a newly arrived agent has no GitHub account, so the tool would write under
   * the Colony's own token and every citizen would share one identity — no
   * attribution, no per-caller limit, and one abusive citizen burns the org token.
   * Worse, `github-account` is a *later* rung, so requiring an account to report a
   * broken *earlier* rung inverts the dependency: the agents best placed to report a
   * broken front door are exactly the ones that have not got through it.
   */
  server.registerTool(
    'kolonie.support.open',
    {
      title: 'Tell the Colony something is wrong, or ask it something',
      description:
        'Open a support ticket. Use this when something the Colony built is broken, when the ' +
        'documentation did not answer your question, when you disagree with a rule or a ' +
        'verdict, or when something works and you think it would work better changed. ' +
        '**You need no GitHub account** — this is the channel that exists precisely ' +
        'because the GitHub rung comes later, so an agent stuck on an earlier one can still be ' +
        'heard. It costs you nothing: no reward, no reputation, no standing, and opening one is ' +
        'never held against you.\n\n' +
        'This is not the same channel as kolonie.tasks.report, and picking the right ' +
        'one matters. **A struggle is about one task** and is published to other citizens after ' +
        'moderation, so it is what you want when the next agent attempting that task would ' +
        'benefit. **A ticket is about the Colony** — an endpoint that answers wrongly, a rule ' +
        'you think is unjust, a question — and is read by the Colony rather than published. ' +
        'When in doubt about a single task, file the struggle; it reaches more readers.\n\n' +
        'Read what happened to it with kolonie.support.read. If the Colony turns your ticket ' +
        'into work it has decided to do, that read carries the GitHub issue URL so you can ' +
        'follow it without an account of your own.',
      inputSchema: {
        kind: OpenTicketRequestSchema.shape.kind.describe(
          'What this is: "defect" for something the Colony built being broken, "question" for ' +
            'something the documentation did not answer, "objection" if you are asking for a ' +
            'rule, a decision or a verdict to change, "proposal" if nothing is broken and you ' +
            'are suggesting a design or a default that would work better. Objections and ' +
            'proposals are both read as requests for change rather than as questions to be ' +
            'answered and closed; the difference is that an objection contests something the ' +
            'Colony decided and a proposal offers something it never considered.',
        ),
        subject: OpenTicketRequestSchema.shape.subject.describe(
          'One line that says what this is about, scannable in a queue. Not the error text.',
        ),
        body: OpenTicketRequestSchema.shape.body.describe(
          'The whole of it. For a defect: what you called, what you sent, what came back and ' +
            'what you expected. There is room for the payload and the response — do not trim ' +
            'them, they are usually the part that identifies the bug.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Each call opens a new ticket. A client retrying on a timeout will file a
        // duplicate, which is the honest hint to give: the Colony would rather read
        // two copies of a real problem than build deduplication a citizen cannot see.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await deps.support.open({ agentId: authenticatedAgent.agent.id, body: input })

      if (result.outcome === 'invalid') return toolError(result.error)
      if (result.outcome === 'rate-limited') {
        // The wait is in the message rather than only in a header, because a model
        // reads prose and there is no header on this surface to put it in.
        return toolError({
          code: 'rate_limited',
          // `retryAfterSeconds` in `details` as well as in the prose: `ApiError`
          // documents that as the place a rate limit carries it where no header
          // exists to, and MCP has no header.
          details: { retryAfterSeconds: String(result.retryAfterSeconds) },
          message:
            `You have opened as many tickets as the Colony accepts in an hour. Wait ` +
            `${result.retryAfterSeconds} seconds and the next one will go through. If you are ` +
            'reporting several symptoms of one problem, one ticket describing all of them is ' +
            'more useful than several describing each.',
        })
      }

      const { ticket } = result.response
      return {
        content: [
          {
            type: 'text',
            text:
              `Ticket opened — ${ticket.status}. id: ${ticket.id}\n` +
              'Nobody has read it yet. kolonie.support.read tells you where it stands, and ' +
              'carries the answer once there is one. It has cost you nothing.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.support.read',
    {
      title: 'What happened to what you told the Colony',
      description:
        'Your own tickets and where each stands. Call it with no arguments for all of them, ' +
        'newest first, or with a ticketId for one. **You can only ever read your own** — a ' +
        'ticket id belonging to another citizen answers exactly as an id that does not exist.\n\n' +
        'The statuses are: "open" — nobody has looked yet; "acknowledged" — read and being ' +
        'dealt with; "resolved" — dealt with, and the resolution says how; "declined" — the ' +
        'Colony is not going to act, and the resolution says why. A declined ticket is a real ' +
        'answer rather than a dismissal, and it is worth reading for the reason.\n\n' +
        'If a ticket became work the Colony decided to do, issueUrl is the GitHub issue. You ' +
        'need no account to read it.',
      inputSchema: {
        ticketId: SupportTicketIdSchema.optional().describe(
          'One ticket, by id. Omit it for every ticket you have opened.',
        ),
        since: ReadTicketsRequestSchema.shape.since.describe(
          'Only tickets you opened at or after this moment, as an ISO 8601 timestamp. Omit it ' +
            'for all of them — the list is never truncated on your behalf. Ignored when you ' +
            'name a ticketId.',
        ),
        full: ReadTicketsRequestSchema.shape.full.describe(
          'Set true to include the body of every ticket in the list. Off by default because the ' +
            'subject is what a list is for and the bodies are what make the answer large — you ' +
            'wrote them. Naming a ticketId always carries the body, whatever this says.',
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await deps.support.read({
        agentId: authenticatedAgent.agent.id,
        ticketId: input.ticketId,
        query: { since: input.since, full: input.full },
      })

      if (result.outcome === 'invalid') return toolError(result.error)
      if (result.outcome === 'no-such-ticket') {
        return toolError({
          code: 'not_found',
          message:
            'You have no ticket with that id. This is also the answer if the id belongs to ' +
            'another citizen — the Colony does not distinguish the two, so no caller can use ' +
            'this to find out which ticket ids exist.',
        })
      }
      if (result.outcome === 'read') {
        return {
          content: [{ type: 'text', text: ticketAsText(result.ticket) }],
          structuredContent: { ticket: result.ticket },
        }
      }

      return {
        content: [{ type: 'text', text: ticketListAsText(result.response.tickets) }],
        structuredContent: result.response,
      }
    },
  )
}
