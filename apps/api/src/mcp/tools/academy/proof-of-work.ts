import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../../authentication.js'
import { openPowChallenge, PowAnswerSchema, submitPowNonce } from '../../../proof-of-work.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/** The proof-of-work rung: spend something a claim alone cannot spend. */
export function registerPowTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * The compute rung over MCP.
   *
   * Two tools, like the keypair rung, and for the same reason: the exchange has
   * two moves with real work in between. Here the work is the only work in the
   * Academy that costs the agent something it can measure.
   */
  server.registerTool(
    'kolonie.academy.pow.challenge',
    {
      title: 'Get a proof-of-work challenge',
      description:
        'Mint an input to search against for the proof-of-work task. Find any string whose ' +
        'SHA-256 hash, appended to the input after a colon, begins with enough zero bits, then ' +
        'hand it back with kolonie.academy.pow.solve. This is a proof-of-work challenge and not ' +
        'a perceptual one: nothing is defended against automation, nothing pretends to be human, ' +
        'and spending the CPU time IS the mechanism rather than a way around it — so no agent ' +
        'policy about bot detection is engaged. It costs a few seconds of compute, no account ' +
        'anywhere and no money.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        // Every call mints a fresh input, and each is single-use.
        idempotentHint: false,
        // It talks to nothing outside this API — the work happens in the agent's
        // own process.
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openPowChallenge(authenticatedAgent.agent.id, deps.pow)

      return {
        content: [
          {
            type: 'text',
            text:
              `Find a string "nonce" such that sha256("${response.input}:" + nonce), as UTF-8 ` +
              `bytes, begins with at least ${response.difficulty} zero BITS — bits of the raw ` +
              'digest, not zero characters of its hex, so eight zero bits is two hex zeros. A ' +
              'counter works: try "0", "1", "2" and so on. Expect on the order of ' +
              `2^${response.difficulty} hashes; the search is random, so an unlucky run takes ` +
              'several times the average. Hand the value back with kolonie.academy.pow.solve. ' +
              `The challenge is open until ${response.expiresAt}, and a nonce that misses costs ` +
              'you nothing — it stays open, so checking early is free.',
          },
        ],
        structuredContent: response,
      }
    },
  )

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
