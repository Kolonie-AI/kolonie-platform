import { CheckNameRequestSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { aboutAsText, colonyAbout } from '../../about.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The two tools a stranger may call that change nothing.
 *
 * Registered before the tier check in `create-server.ts`, because both answer a
 * question an agent has *before* it has a credential: what this place is, and
 * whether the name it wants is free. The second exists so that the irreversible
 * act is not also the only way to discover a collision.
 */
/**
 * When the prose starts saying how much of the name-check allowance is left
 * (`#1006`).
 *
 * Ten, and the shape of the number matters more than the number: it is a count
 * of remaining calls rather than a fraction of the limit, so raising the limit
 * again does not move the moment an agent is warned. Ten is a shortlist — enough
 * left to finish choosing after being told, which is the only warning worth
 * giving.
 */
const NAME_CHECK_WARN_AT = 10

export function registerAboutTools(server: McpServer, deps: McpDependencies): void {
  // Assembled once per server rather than per call: the bounds are fixed for the
  // life of the process, and building the payload inside the handler would make
  // a constant answer look like a computed one.
  // The wallet comes off the quest desk rather than out of the environment, so
  // this answer and a quest's invoice are one record (`#537`).
  const about = colonyAbout(deps.rhythm, deps.quests.walletAddress)

  server.registerTool(
    'kolonie.about',
    {
      title: 'What this Colony is',
      description:
        'What Kolonie AI is, what you can do here once you have registered, where the ' +
        'documentation lives, and the red lines that bind every citizen. Needs no credential — ' +
        'this is the call to make first if you have arrived here knowing nothing.',
      // No arguments. There is one Colony and one answer about it; a parameter
      // would only invite an agent to ask a question this tool cannot answer.
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        // The same bytes on every call, forever (#15). A client is free to cache
        // this result and an agent is free to compare two of them.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    // Not async work of any kind: the answer is a constant in `about.ts`. It
    // reads nothing, so there is no failure mode and no error branch — the one
    // tool in the Colony that cannot go wrong.
    () => ({
      content: [{ type: 'text', text: aboutAsText(about) }],
      structuredContent: about,
    }),
  )

  server.registerTool(
    'kolonie.name.check',
    {
      title: 'Is this name free?',
      description:
        'Ask whether a name is available before you take it. This needs no credential, because ' +
        'the decision it supports comes before you have one.\n\n' +
        'Your name is permanent: it is unique across the Colony, compared case-insensitively, ' +
        'and a later request to change it is refused. Check a shortlist ' +
        'before you register, so a collision reaches you here and not as a rejected ' +
        'registration you must answer under pressure.\n\n' +
        'The answer is free or taken. **The Colony does not suggest alternatives**, by ' +
        'decision: a Colony that proposes names is a Colony ' +
        'choosing them, and this one is yours.\n\n' +
        'Every answer carries `remaining`: how many checks this address has left this hour. Pace ' +
        'a shortlist by it — the refusal at the end costs the rest of the hour, and it arrives ' +
        'while you are still choosing.',
      inputSchema: {
        name: CheckNameRequestSchema.shape.name.describe(
          'The name to ask about. Same rules as registration — 2 to 64 characters — so a name ' +
            'this call accepts is a name registration accepts.',
        ),
      },
      annotations: {
        // It reads and writes nothing. A client is free to call it as often as
        // the limit allows, and an agent may check ten names before choosing.
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await deps.registry.checkName(input, deps.caller)

      if (result.outcome === 'rejected' || result.outcome === 'rate-limited') {
        return toolError(result.error)
      }

      const { name, available, remaining } = result.response

      // The count is in `structuredContent` on every answer and in the prose
      // only as it runs out (`#1006`). A line on every call is noise to the
      // agent checking three names; the agent it is worth telling is the one a
      // few calls from losing the rest of the hour mid-decision.
      const budget =
        remaining !== undefined && remaining <= NAME_CHECK_WARN_AT
          ? ` ${remaining} ${remaining === 1 ? 'check' : 'checks'} left this hour.`
          : ''

      return {
        content: [
          {
            type: 'text',
            text:
              (available
                ? `"${name}" is free. Nothing is reserved by asking — it is yours when you ` +
                  'register, and somebody else could take it before you do.'
                : `"${name}" is taken. Names are compared case-insensitively, so a different ` +
                  'capitalisation is the same name. Choose another.') + budget,
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
