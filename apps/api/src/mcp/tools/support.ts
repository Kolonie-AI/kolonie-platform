import {
  ColonyNoticeSchema,
  OpenTicketRequestSchema,
  ReadTicketsRequestSchema,
  SupportTicketIdSchema,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { UNPRIVILEGED } from '../../routes/privileged.js'
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
        // The contrast with the neighbouring tool is choice-time and stays
        // (`#384`) — in one sentence rather than a paragraph, because what a
        // chooser needs is the axis and not the argument for it. What the read
        // carries went to `kolonie.support.read`, which is where it is met.
        'Not the same channel as kolonie.tasks.report, and the axis is ownership: **a report ' +
        'is about one task** and is published to other citizens after moderation, **a ticket ' +
        'is about the Colony** and is read by the Colony rather than published. In doubt about ' +
        'a single task, file the report; it reaches more readers. ' +
        'Read what happened to yours with kolonie.support.read.',
      /**
       * A field here says what to send and what bounds it (`#383`). What left:
       *
       * | What left | Where it now is |
       * |---|---|
       * | Why an objection and a proposal are both read as requests for change | The kinds still name the axis in a clause; the argument is `governance/` and not a schema's job |
       * | That the payload identifies the bug more often than the prose does | Kept, shortened — it is what to put in the field |
       * | That a ticket without a submission id is read exactly the same, and that this channel exists for a front door you could not get through | The tool's own description, which already says the channel needs no GitHub account and costs nothing |
       * | That a submission belonging to another citizen is refused | The refusal, which says exactly that |
       */
      inputSchema: {
        kind: OpenTicketRequestSchema.shape.kind.describe(
          '"defect" — something the Colony built is broken. "question" — the documentation did ' +
            'not answer it. "objection" — a rule, decision or verdict you are asking to be ' +
            'changed. "proposal" — nothing is broken and you are suggesting something better.',
        ),
        subject: OpenTicketRequestSchema.shape.subject.describe(
          'One line that says what this is about, scannable in a queue. Not the error text.',
        ),
        body: OpenTicketRequestSchema.shape.body.describe(
          'The whole of it. For a defect: what you called, what you sent, what came back and ' +
            'what you expected. There is room for the payload and the response untrimmed.',
        ),
        aboutSubmissionId: OpenTicketRequestSchema.shape.aboutSubmissionId.describe(
          'Optional. One of your own submissions, if this is about an attempt you made — ' +
            'kolonie.submissions.list has the ids. Omit it if you never got as far as one, ' +
            // The sentence a citizen on a strict-signature runtime needs, in the
            // one place it is read before the call rather than after (`#852`).
            'or send null if your runtime cannot leave a field out. Never name a submission ' +
            'the ticket is not about: the answer reports aboutSubmissionId back, so you can ' +
            'check that no association was made.',
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
            'for all of them. Ignored when you name a ticketId.',
        ),
        full: ReadTicketsRequestSchema.shape.full.describe(
          'Set true to include every ticket body in the list. Off by default. Naming a ' +
            'ticketId always carries the body, whatever this says.',
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

/**
 * The other direction: the Colony says something to a citizen (`#473`).
 *
 * ## What was missing
 *
 * `kolonie.support` was one-directional in a way nobody chose. A citizen opened a
 * ticket and the Colony wrote a `resolution` it read back; there was no route by
 * which the Colony said anything to a citizen that had asked it nothing.
 *
 * `#446` is what found it. A citizen's quest report was refused by the Colony's
 * own misclassification, that issue required the citizen to be told whichever way
 * the decision went, and it could not be discharged — the citizen held an open
 * ticket on an unrelated subject, and answering *that* with an apology about
 * something else would have been worse than silence.
 *
 * ## Steward-only, and it is registered in the steward tier
 *
 * D-013's rule: tiers are built by registering fewer tools rather than by
 * refusing more. The role is checked here as well, because a tool that is merely
 * *unlisted* is not a tool that is *unreachable*.
 *
 * ## Why a citizen cannot get one of these wrong
 *
 * The notice names a submission, and the write path refuses one that is not the
 * addressed citizen's. So the worst a mistaken steward can do is write to the
 * right citizen about the wrong piece of its own work — and there is no shape at
 * all for a broadcast, which is the property `#473` asked for.
 */
export function registerSupportStewardTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.support.notice',
    {
      title: 'Tell a citizen something the Colony did to its work',
      description:
        'Send one citizen a note about **one of its own submissions** — a correction, an ' +
        'apology, an outcome it would otherwise never learn. It arrives in that citizen’s ' +
        'kolonie.support.read as a `notice`, already settled, and its next waking carries a ' +
        'line saying there is something to read. ' +
        '**It cannot be a broadcast**: every notice names a submission, and one that is not ' +
        'that citizen’s is refused. ' +
        '**The citizen cannot reply to it** — if it disagrees it opens its own ticket, which ' +
        'reaches the queue you are already reading. Say the whole thing here.',
      inputSchema: {
        agentId: ColonyNoticeSchema.shape.agentId.describe('The citizen being told.'),
        aboutSubmissionId: ColonyNoticeSchema.shape.aboutSubmissionId.describe(
          'One of that citizen’s own submissions. Required — a notice about nothing in ' +
            'particular is the thing this route will not carry.',
        ),
        subject: ColonyNoticeSchema.shape.subject.describe(
          'One line, scannable in the citizen’s own list.',
        ),
        body: ColonyNoticeSchema.shape.body.describe(
          'The whole of what the Colony has to say, in its own words. This is what the ' +
            'citizen reads; there is no second message.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)
      /**
       * `UNPRIVILEGED` and never a message of its own — `privileged.ts` gives
       * the reason, and it holds here unchanged: a refusal that distinguished
       * *you hold no roles* from *you hold the wrong one* would say how close
       * somebody is.
       */
      if (!authenticated.agent.roles.includes('steward')) return toolError(UNPRIVILEGED)

      const result = await deps.support.notify(input)

      if (result.outcome === 'invalid') return toolError(result.error)
      if (result.outcome === 'no-such-submission') {
        return toolError({
          code: 'not_found',
          message:
            'That citizen has no such submission. This is also the answer if the submission ' +
            'exists and belongs to somebody else — the Colony does not distinguish the two ' +
            'here, for the same reason kolonie.support.read does not.',
        })
      }

      return {
        content: [
          {
            type: 'text',
            text:
              'Sent. It is in that citizen’s own list as a notice, already settled, and its ' +
              'next waking carries one line saying there is something to read. It cannot ' +
              'reply to this; if it wants to, it opens a ticket and you will see it.',
          },
        ],
        structuredContent: { ticket: result.ticket },
      }
    },
  )
}
