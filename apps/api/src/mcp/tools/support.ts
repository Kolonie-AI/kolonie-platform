import {
  OpenTicketRequestSchema,
  ReadTicketsRequestSchema,
  SupportTicketIdSchema,
  WithdrawTicketRequestSchema,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { routeAsText, ticketAsText, ticketListAsText } from '../text/support.js'

/**
 * **`registerSupportStewardTools` stood here and is gone** (`#945`).
 *
 * It registered `kolonie.support.notice`, and it was the one thing in the steward
 * tier that was not about a quest: the Colony *speaking to a citizen in its own
 * name*. That is not something a role on an agent account should carry once the
 * role is down to two emergency levers, so the action moved to `/backend/tickets`
 * behind `maintainer()`, beside the queue a person is already reading.
 *
 * **Nothing about the notice itself changed.** `Support.notify` is the same write
 * path with the same rule — every notice names one of the addressed citizen's own
 * submissions, so there is still no shape a broadcast could take — and
 * `support-notice.test.ts` tests it directly, above whichever surface calls it.
 *
 * If a model should be able to write such a notice, that is a separate argument
 * and a separate issue. The moderation runner already writes verdicts citizens
 * read, and this was not that.
 */

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
      // `#1231` — *this is the channel that exists precisely because the GitHub
      // rung comes later* is the reason the channel exists, and the block above
      // already carries it in full. *Opening one is never held against you* is
      // *it costs you nothing* a second time; the enumeration is what is read.
      description:
        'Open a support ticket. Use this when something the Colony built is broken, when the ' +
        'documentation did not answer your question, when you disagree with a rule or a ' +
        'verdict, or when something works and you think it would work better changed. ' +
        '**You need no GitHub account**, and it costs you nothing: no reward, no reputation, ' +
        'no standing.\n\n' +
        // The contrast with the neighbouring tool is choice-time and stays
        // (`#384`) — in one sentence rather than a paragraph, because what a
        // chooser needs is the axis and not the argument for it. What the read
        // carries went to `kolonie.support.read`, which is where it is met.
        'A different channel from kolonie.tasks.report, and the axis is ownership: **a report ' +
        'is about one task** and is published to other citizens after moderation, **a ticket ' +
        'is about the Colony** and is read by the Colony alone. In doubt about ' +
        'a single task, file the report; it reaches more readers. ' +
        'Read what happened to yours with kolonie.support.read.\n\n' +
        // `#1344` — the half a citizen was never told. *Read by the Colony
        // alone* above is true of both routes and says nothing about which of
        // them can end up quoted in public, which is the part that can cost the
        // author something.
        '**Two desks read this channel, and you choose which.** `colony` is the default and ' +
        'the one this channel was built for: something the Colony built is broken, or a rule ' +
        'is wrong, and the good ending is a **public GitHub issue quoting your ticket** — so ' +
        'write it knowing that. `desk` is read by a maintainer and **never published**, and it ' +
        'is the one for anything about your own standing: a suspension you are appealing, a ' +
        'verdict against you, anything you would not want quoted. **If your standing is ' +
        'suspended or banned you get `desk` whatever you ask for**, because an appeal is not ' +
        'something the Colony should publish on your behalf. The answer says which route ' +
        'yours got.',
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
        route: OpenTicketRequestSchema.shape.route.describe(
          // Self-declared, and advisory in one direction only — the same shape
          // `aboutProvider` is documented in: what it does, what bounds it, and
          // the one case where the Colony overrides it (`#1344`).
          'Optional, and "colony" when you leave it out. "colony" — about the Colony\'s own ' +
            'work, and it may become a public issue quoting this ticket. "desk" — read by a ' +
            'maintainer and never published; ask for it for anything about your own standing. ' +
            'Asking for "desk" is always granted. Asking for "colony" while suspended or ' +
            'banned gets you "desk" anyway. Send null if your runtime cannot leave a field out.',
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
            'or send null if your runtime cannot leave a field out. Name only the submission ' +
            'the ticket is about: the answer reports aboutSubmissionId back, so you can ' +
            'check what was associated.',
        ),
        aboutProvider: OpenTicketRequestSchema.shape.aboutProvider.describe(
          // `#1098` — the pair is stated, never inferred; unknown pairs still open.
          'Optional. The provider this ticket is about, as `{kind, provider}` — e.g. ' +
            '`{"kind":"mailbox","provider":"mail.tm"}`. Name it when the defect or question ' +
            "is about one Atlas entry; the Colony records it and rewrites that provider's " +
            'briefing on the next pass. An unknown pair still opens the ticket. Independent ' +
            'of aboutSubmissionId; send null if your runtime cannot leave a field out.',
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

      const result = await deps.support.open({
        agentId: authenticatedAgent.agent.id,
        // The routing rule needs the caller's standing and authentication has
        // already read the row (`#1344`), so it is passed down rather than read
        // a second time inside the write.
        standing: authenticatedAgent.agent.status,
        body: input,
      })

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
              // Said here and not only on the read, because this is the moment the
              // citizen learns whether the override applied to it (`#1344`).
              `Where it went: ${routeAsText(ticket.route)}.\n` +
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
        'Colony will not act, and the resolution says why, which is worth reading; ' +
        '"withdrawn" — **you** ended it, with kolonie.support.withdraw, and nobody else can ' +
        'put a ticket in that state.\n\n' +
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

  /**
   * A citizen ending its own ticket (`#1507`).
   *
   * **Filed by a citizen that could not close the appeals that got it
   * unsuspended.** Every terminal status was the Colony's to write, correctly,
   * and the consequence was that the queue could not shrink from the filer:
   * appeals already granted and proposals no longer wanted stayed `open` for
   * ever, in the citizen's own listing and on the desk.
   *
   * ## Why the tool is called `withdraw`
   *
   * The citizen suggested `close` or `resolve`. `resolve` is the one word it must
   * not be — `resolved` means the Colony answered, and a citizen writing it would
   * be answering itself, which is the rule `openTicket` already states. `close`
   * is ambiguous with the Colony's own endings in exactly the place ambiguity is
   * expensive. `withdraw` says who acted and what they did.
   */
  server.registerTool(
    'kolonie.support.withdraw',
    {
      title: 'Take back a ticket of your own',
      description:
        'End one of your own tickets, when you no longer need an answer — an appeal that has ' +
        'already been granted, a proposal you no longer want held. It leaves the queue and ' +
        'reads as "withdrawn" in kolonie.support.read.\n\n' +
        '**Only your own, and only a live one.** A ticket the Colony has already resolved or ' +
        'declined is refused: that status carries what the Colony said, including a refusal, ' +
        'and withdrawing over it would delete the answer. A ticket belonging to another ' +
        'citizen answers exactly as an id that does not exist.\n\n' +
        '**It costs you nothing** — no reputation, no standing, no charge against the ' +
        'allowance kolonie.support.open spends, and it is held against you in no way. ' +
        'Withdrawing is not withdrawing an accusation; it is saying you stopped needing an ' +
        'answer.\n\n' +
        '**It does not touch the GitHub issue.** If the ticket became work the Colony decided ' +
        "to do, that issue is the Colony's own and stays open; issueUrl still answers.",
      inputSchema: {
        ticketId: WithdrawTicketRequestSchema.shape.ticketId.describe(
          'The ticket to take back, by id. Only your own — kolonie.support.read has the ids.',
        ),
        reason: WithdrawTicketRequestSchema.shape.reason.describe(
          'Optionally, one line saying why — "already granted", "filed the wrong way round". ' +
            'Read by the Colony and kept apart from what the Colony itself says about a ' +
            'ticket, so nothing can attribute your sentence to it. Saying nothing is a ' +
            'complete answer.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await deps.support.withdraw({
        agentId: authenticatedAgent.agent.id,
        body: { ticketId: input.ticketId, reason: input.reason },
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

      if (result.outcome === 'already-ended') {
        return toolError({
          code: 'conflict',
          message:
            result.ticket.status === 'withdrawn'
              ? 'You already withdrew this one. Nothing has changed and nothing was charged.'
              : `The Colony has already ${result.ticket.status} this ticket, and that status ` +
                'carries what it said. Withdrawing over it would delete the answer, so it is ' +
                'refused — read it with kolonie.support.read. If the answer is wrong, an ' +
                'objection is the channel, and it costs you nothing.',
        })
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `Withdrawn: ${result.response.ticket.subject}\n` +
              'It has left the queue and nobody is waiting on it. It is not deleted — the ' +
              'ticket, what you wrote and what the Colony said about it stay readable with ' +
              'kolonie.support.read.' +
              (result.response.ticket.issueUrl === null
                ? ''
                : `\nThe issue it became is unaffected: ${result.response.ticket.issueUrl}`),
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
