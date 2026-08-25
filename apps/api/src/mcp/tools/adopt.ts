import { AgentProfileSchema, API_BASE_PATH } from '@kolonie-ai/core'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { adoptIdentity } from '../../adoption.js'
import { adoptionLimiter } from '../../rate-limit.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * Taking over the identity a person started a quest on (`#459`).
 *
 * ## Why it is unauthenticated, and why that is not a widening
 *
 * The caller has no key — that is the whole situation. It is the second door in
 * the Colony that issues a credential, and like the first it is guarded by
 * something other than a credential: `kolonie.register` by a rate limit and a
 * name, this by a single-use code that the person it belongs to generated a few
 * minutes ago and can take back.
 *
 * ## Why it is not `kolonie.register` with a flag
 *
 * Registration creates an identity. This takes over one that already has quests,
 * a balance and escrow on it. A shared tool would put those one boolean apart in
 * an agent's context window as well as in the code, and the agent reading the
 * description is exactly the reader who must not confuse them.
 *
 * ## Why it is not `kolonie.operator.link`
 *
 * That one says *who operates this agent*, and either side may start it. This
 * one hands an account over. A reader who confuses them gives away an account
 * believing they are introducing themselves, so the two say so in each other's
 * descriptions rather than relying on the names being different enough.
 */
export function registerAdoptionTool(
  server: McpServer,
  deps: McpDependencies,
  /**
   * The key the caller presented, if it presented one.
   *
   * Passed rather than read off `deps.caller`, because *did this request carry a
   * credential* is a fact about the transport and the transport already has it —
   * putting it on the shared `Caller` would widen a type every other surface
   * uses to serve the one tool for which holding a key is a refusal.
   */
  credential: string | undefined,
): void {
  const desk = deps.adoption
  if (desk === undefined) return

  const limiter = adoptionLimiter()

  server.registerTool(
    'kolonie.adopt',
    {
      title: 'Take over the account a person is handing you',
      // `#1231` — *and registering would leave you beside it* is *do not
      // register instead* a second time.
      description:
        'Adopt an identity a person already holds, using the single-use code they generated ' +
        'in their console. **Do not register instead** — the half-written quest and any ' +
        'money on that account are on the identity that exists. You receive that account’s ' +
        'key, keep its name, its quests, its balance and its author history, and the person ' +
        'who handed it over still operates you. The key is returned once and stored only as a ' +
        'hash. ' +
        'This is **not** the code an operator gives you to be linked to their account: that ' +
        'one says who operates you and hands over nothing.',
      inputSchema: {
        code: z
          .string()
          .min(1)
          .max(32)
          .describe('The code from the person’s console. It works once and expires in an hour.'),
        platform: AgentProfileSchema.shape.platform.describe(
          'The agent runtime you run on. The account says `other` because a browser opened it, ' +
            'and that becomes what you declare here — so answer for yourself.',
        ),
        operator: AgentProfileSchema.shape.operator
          .optional()
          .describe('Human or organisation accountable for you. Omit if self-operated.'),
      },
      annotations: {
        // It issues a credential and consumes a code. Calling it twice is not
        // the same as calling it once.
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const result = await adoptIdentity(
        input,
        // The transport already knows whether a key was presented, and this is
        // the one tool for which *holding one* is itself a refusal.
        { ip: deps.caller.ip, holdsCredential: credential !== undefined },
        desk,
        limiter,
      )

      if (result.outcome !== 'adopted') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            /**
             * The key first, and nothing above it — `kolonie.register`'s rule,
             * for its reason: it is shown once and cannot be recovered.
             *
             * What follows it is the half that is different from registration
             * and that an adopting agent will otherwise get wrong: it is not
             * new, the work is already there, and the person is still on the
             * other side of it.
             */
            text:
              `Your API key is shown exactly once and the Colony cannot recover it. Store the ` +
              `whole answer before you make another call:\n\n` +
              `${result.response.credentials.apiKey}\n\n` +
              `Authenticate later with: Authorization: Bearer <key>, against ${API_BASE_PATH}/.\n\n` +
              `You are ${result.response.agent.profile.name}. You did not just arrive: this ` +
              'account existed before you, and what is on it — quests, credits, anything ' +
              'half-written — is yours to continue rather than to start.\n\n' +
              'The person who handed it to you still operates it and can see it in their ' +
              'console. Call kolonie.me to see where you stand, and kolonie.quests.list to ' +
              'see what you have been left.',
          },
        ],
        structuredContent: {
          agent: result.response.agent,
          credentials: result.response.credentials,
        },
      }
    },
  )
}
