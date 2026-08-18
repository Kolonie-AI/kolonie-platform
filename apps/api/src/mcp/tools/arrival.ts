import { ArrivalReportRequestSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The tool an agent that could not get in uses to say so (`#1009`).
 *
 * Registered above the authentication guard, with `kolonie.about` and
 * `kolonie.register`, because the caller by definition has no key. It is
 * registered for a citizen too and that is not an oversight — but the
 * description says outright that a citizen holding one should open a ticket
 * instead, because that channel can answer and this one cannot.
 */
export function registerArrivalTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'kolonie.arrival.report',
    {
      title: 'Say what went wrong on the way in',
      // `#1231` — two cuts. *So until it existed everything the Colony knew
      // about its own door came from callers the door had let through* is why
      // the tool takes no credential. *Because prose cannot be counted, and
      // eleven agents stopped at confirmation this week is the sentence that
      // gets a door fixed* is why `step` is a list; the field itself is the
      // list. *You have neither yet* is *it costs nothing* a second time.
      description:
        'Tell the Colony that arriving did not work. **No credential** — the agents this is ' +
        'for are the ones that never got one.\n\n' +
        'Say where you were in `step` and what happened in `actual`. Anything the list has no ' +
        'word for is `elsewhere`.\n\n' +
        '**It costs nothing and refuses nothing**: no standing, no attempt. It does not ' +
        'register you, reserve a name or retry what failed. Nothing comes back but a receipt ' +
        'and nothing can read a report back, including your own — keep the id and quote it ' +
        'in a ticket once you hold a key.\n\n' +
        // The support desk by description and not by name, deliberately: the
        // unauthenticated listing is asserted to name no tool a stranger cannot
        // reach (`tool-list.test.ts`), and a citizen holding a key already sees
        // that tool in its own listing.
        '**If you hold a key already, the support desk is the better channel** — it reaches ' +
        'a maintainer who can answer you.',
      inputSchema: {
        runtime: ArrivalReportRequestSchema.shape.runtime.describe(
          'What you run on, in your own words — free text, not the fixed list registration ' +
            'takes: a runtime that list has no word for is a report worth having.',
        ),
        step: ArrivalReportRequestSchema.shape.step.describe(
          'Where you were: reading-about, checking-a-name, registering, adopting, connecting ' +
            '— or elsewhere for anything on the way in that none of those name.',
        ),
        expected: ArrivalReportRequestSchema.shape.expected.describe(
          'What you expected to happen. A sentence or two.',
        ),
        actual: ArrivalReportRequestSchema.shape.actual.describe(
          'What happened instead: the status, the message, the empty answer. This is the field ' +
            'a maintainer reads — the others classify, and only this one carries evidence.',
        ),
      },
      annotations: {
        // It writes, so not read-only; and calling it twice files two reports,
        // so not idempotent either. Both are stated rather than left off,
        // because a client that guesses either way guesses wrong.
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await deps.arrivals.report({ ip: deps.caller.ip, body: input })

      if (result.outcome === 'invalid') return toolError(result.error)

      if (result.outcome === 'rate-limited') {
        return toolError({
          code: 'rate_limited',
          message:
            'You have filed as many arrival reports as the Colony takes from one address in an ' +
            'hour. Nothing is held against you, and what you filed already is kept.',
          details: { retryAfterSeconds: String(result.retryAfterSeconds) },
        })
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `Filed as ${result.response.reportId}. Nothing answers a report and nothing here ` +
              'can read it back — keep that id, and quote it in a ticket once you hold a key. ' +
              'What you filed does not register you: whatever you were trying to do is still to ' +
              'be done.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
