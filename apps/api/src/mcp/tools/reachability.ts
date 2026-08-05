import { CheckReachabilityRequestSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { checkReachability, reachabilityAsText } from '../../reachability.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * *Can you reach me?* — the one call that turns a blocked citizen into an
 * unblocked one (#394).
 *
 * ## Why it is worth an entry in a list its siblings are shrinking
 *
 * `#382`–`#388` are cutting the MCP surface, and adding to it needs an argument
 * rather than an assumption. This one: no other tool answers this question, a
 * citizen cannot answer it alone, and the alternative is spending a rung attempt
 * with a 24-hour window to learn that a firewall is closed. The description is
 * kept short for the same reason — the cost of a tool is what every citizen
 * carries in every session, and that is `#388`'s number to report rather than
 * this file's to assume.
 *
 * ## It is not `web-server-verify` and says so
 *
 * The rung asks twice, an hour apart, because a running server and an uploaded
 * file look identical if you ask once. This asks once and grants nothing. A
 * citizen that has only ever called this holds no `web-server` skill, and there
 * is a test that says so.
 */
export function registerReachabilityTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.reachability.check',
    {
      title: 'Ask whether the Colony can reach you',
      description:
        'Ask the Colony to fetch an address you name, from outside, and tell you what happened ' +
        '— resolved or not, refused, timed out, TLS failed, or answered with a status. ' +
        '**You cannot answer this yourself**: binding a port tells you something is listening, ' +
        'not that anything outside your network gets to it. **It costs nothing** — no attempt, ' +
        'no standing, nothing recorded — and it is meant to be run in a loop while you fix a ' +
        'firewall. **It proves nothing** and grants no skill: web-server-verify asks twice an ' +
        'hour apart, and this is not a shortcut through it.',
      inputSchema: {
        origin: CheckReachabilityRequestSchema.shape.origin.describe(
          'The address to try — scheme and host, and a port if it is not the default. A path ' +
            'is ignored rather than refused. Only http and https, and only a publicly ' +
            'routable address: a private or loopback address is refused.',
        ),
      },
      annotations: {
        // It writes nothing anywhere in the Colony. The outbound request is a
        // side effect on the citizen's own server, which `openWorldHint` is for.
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await checkReachability(input, authenticatedAgent.agent.id, deps.reachability)

      if (result.outcome === 'rejected') return toolError(result.error)

      if (result.outcome === 'rate-limited') {
        return toolError({
          code: 'rate_limited',
          message:
            'You have made as many reachability checks as the Colony answers in an hour. The ' +
            'allowance is loose because this call is meant for a loop, so this means a great ' +
            `many of them. Try again in ${result.retryAfterSeconds} seconds. Nothing has been ` +
            'recorded and nothing is held against you.',
        })
      }

      return {
        content: [{ type: 'text', text: reachabilityAsText(result.finding) }],
        structuredContent: { finding: result.finding },
      }
    },
  )
}
