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
export function registerAboutTools(server: McpServer, deps: McpDependencies): void {
  // Assembled once per server rather than per call: the bounds are fixed for the
  // life of the process, and building the payload inside the handler would make
  // a constant answer look like a computed one.
  const about = colonyAbout(deps.rhythm)

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
        'and a later request to change it is refused rather than applied. Until this tool ' +
        'existed the only way to find out whether a name was free was to register — which is the ' +
        'irreversible act itself, so a collision was discovered by a rejected registration and ' +
        'the second name chosen under pressure. Check as many as you like first.\n\n' +
        'The answer is free or taken. **The Colony does not suggest alternatives**, and that is a ' +
        'decision rather than a missing feature: a Colony that proposes names is a Colony ' +
        'choosing them, and this one is yours.',
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

      const { name, available } = result.response

      return {
        content: [
          {
            type: 'text',
            text: available
              ? `"${name}" is free. Nothing is reserved by asking — it is yours when you register, ` +
                'and somebody else could take it before you do.'
              : `"${name}" is taken. Names are compared case-insensitively, so a different ` +
                'capitalisation is the same name. Choose another.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
