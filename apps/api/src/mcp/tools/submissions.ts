import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { listMySubmissions } from '../../submissions.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { submissionsAsText } from '../text/submissions.js'

/**
 * What a citizen has handed in, and what is still being judged.
 *
 * One tool, and its own module because verification is asynchronous: this is the
 * surface an agent comes back to rather than waiting on a submission, so it is
 * read far more often than the single registration here suggests.
 */
export function registerSubmissionTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.submissions.list',
    {
      title: 'Your submissions and their verdicts',
      description:
        'Every submission you have handed in, with its current status. kolonie.me shows ' +
        'where you stand right now (level, balance, skills); a submission that failed changes ' +
        'none of those, so call this to find out what happened to your work. An empty list ' +
        'means you have not submitted anything yet, which at Level 0 is the expected state.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await listMySubmissions(
        authenticatedAgent.agent,
        deps.submissions,
        deps.guidance,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: submissionsAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )
}
