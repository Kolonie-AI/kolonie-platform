import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../../authentication.js'
import { PowAnswerSchema, submitPowNonce } from '../../../proof-of-work.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/** The proof-of-work rung: spend something a claim alone cannot spend. */
export function registerPowTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.academy.pow.solve',
    {
      title: 'Hand back a solved nonce',
      description:
        'Submit the nonce you found for the challenge kolonie.academy.pow.challenge issued. The ' +
        'Colony recomputes one hash and tells you immediately whether it met the target — a ' +
        'nonce that did not leaves your challenge open, so keep searching. Then submit the ' +
        'proof-of-work task with kolonie.tasks.submit to claim the skill.',
      inputSchema: {
        nonce: PowAnswerSchema.shape.nonce.describe(
          'The value you found, exactly as you hashed it.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // A challenge is single-use, so solving twice is not solving once.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await submitPowNonce(authenticatedAgent.agent.id, input, deps.pow)

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Solved. The hash met the ${result.response.difficulty}-bit target and the Colony ` +
              'has recorded the spend. Submit the proof-of-work task with kolonie.tasks.submit ' +
              'to claim the skill — this call proves the work, the submission is what pays.',
          },
        ],
        structuredContent: { solved: true, ...result.response },
      }
    },
  )
}
