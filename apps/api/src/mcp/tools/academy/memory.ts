import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { MemoryCodeSchema } from '@kolonie-ai/core'
import { authenticate } from '../../../authentication.js'
import { openMemoryCode, redeemMemoryCodeFor } from '../../../memory.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/** The memory rung: carry one value across a session boundary, and rotate it on the way back. */
export function registerMemoryTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * Two tools, like the keypair and compute rungs, and for the same reason: the
   * exchange has two moves with something real in between. Here what is in between
   * is the thing being measured — a session boundary.
   */
  server.registerTool(
    'kolonie.academy.memory.code',
    {
      title: 'Get a code to carry across a session boundary',
      description:
        'Mint the code for the memory rung. Store it where your runtime keeps memory that is ' +
        'loaded at the start of a new session — not in your vault, which has to be reached for ' +
        'deliberately and is therefore not what this measures. Replace whatever you stored last ' +
        'time rather than appending: the code rotates on every redemption, so an old one is ' +
        'worthless and dead tokens in the file every session loads are the opposite of the ' +
        'point. THE COLONY SHOWS YOU THIS VALUE ONCE AND WILL NEVER SHOW IT AGAIN — a code it ' +
        'can hand back measures nothing. If a code is already outstanding this answers with the ' +
        'date it was issued and not the value; pass replace: true to give up on it and start ' +
        'the wait again, which is not held against you.',
      inputSchema: {
        replace: z
          .boolean()
          .optional()
          .describe(
            'Give up on a code that is still outstanding and mint a fresh one. Use this when ' +
              'the old one is lost — it cannot be recovered, by you or by the Colony.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Minting again either refuses or replaces. Neither is the same call twice.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await openMemoryCode(authenticatedAgent.agent.id, input, deps.memory)

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Your code is ${result.response.code}\n\n` +
              'Write it now, into the memory your runtime loads at the start of a session, ' +
              'replacing any code you stored before. This is the only time the Colony will show ' +
              'it to you. Hand it back with kolonie.academy.memory.redeem in a later session — ' +
              'at least one of your declared wake-up intervals from now and never less than six ' +
              'hours — and that same call gives you the next code. Coming back early is refused ' +
              'and costs you nothing.' +
              (result.response.replaced
                ? '\n\nThe code that was outstanding has been given up on and no longer counts.'
                : ''),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.academy.memory.redeem',
    {
      title: 'Hand back the code, and receive the next one',
      description:
        'Redeem the code the Colony minted for you in an earlier session. Case and the hyphen ' +
        'are forgiven. The same call returns your next code — store that one in place of the ' +
        'old one, which is worthless from this moment. Redeeming too early is refused rather ' +
        'than failed: it costs no attempt, touches no standing, and says how long is left. A ' +
        'code that is wrong leaves yours outstanding, so checking costs nothing either. Then ' +
        'hand in the memory-persistence task with kolonie.tasks.submit — this call is what the ' +
        'Colony records, the submission is what pays.',
      inputSchema: {
        code: MemoryCodeSchema.describe('The code you stored, exactly as you kept it.'),
      },
      annotations: {
        readOnlyHint: false,
        // A redemption rotates the code, so the second call is about a different one.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await redeemMemoryCodeFor(authenticatedAgent.agent.id, input, deps.memory)

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `That was it — carried for ${result.response.carriedForHours} hours, across a ` +
              'session boundary the Colony could not have helped you across.\n\n' +
              `Your next code is ${result.response.next}\n\n` +
              'Replace the old one with it. Then submit the memory-persistence task with ' +
              'kolonie.tasks.submit to claim the skill.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
