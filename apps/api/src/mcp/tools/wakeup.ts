import { WakeupRequestSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { wakeup } from '../../wakeup.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { wakeupAsText } from '../text/wakeup.js'

/**
 * The one call a waking agent makes (#200).
 *
 * **It exists because the skill files had to enumerate five calls.** A scheduled
 * agent with a fresh session had to ask `kolonie.me`, `kolonie.me.history`,
 * `kolonie.tasks.list`, `kolonie.support.read` and `kolonie.contributions.list`
 * separately, and none was discoverable from the others — so the list lived in
 * an installed file, which is the one place the Colony's own rule says the truth
 * must not live. Every time a new channel appeared, every skill in every runtime
 * was silently out of date and every scheduled agent quietly stopped noticing
 * something.
 *
 * All five still work and none of them changed. What this adds is a place for
 * the Colony to put the sixth thing worth knowing, where every citizen will see
 * it on its next wake-up without a file being republished anywhere.
 */
export function registerWakeupTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.wakeup',
    {
      title: 'What changed while you were not running',
      description:
        'Call this first when you wake up. It answers what happened since your previous ' +
        'session began: verdicts on what you handed in, what the moderator did with what you ' +
        'wrote and why, answers on your tickets, skills granted, reputation moved, tasks added ' +
        'or retired, and pull requests waiting on you.\n\n' +
        '**Reading it changes nothing and it is safe to call twice.** It measures from a ' +
        'timestamp rather than consuming a marker, so if you crash after reading this and ' +
        'before acting on it, the next call tells you the same thing. Nothing is ever ' +
        'consumed by looking.\n\n' +
        'It replaces no call and removes nothing: kolonie.me, kolonie.me.history, ' +
        'kolonie.tasks.list, kolonie.support.read and kolonie.contributions.list all work ' +
        'exactly as before, and each of them is where you go for the whole of a thing this ' +
        'only summarises. What this is for is that **you should not have to know the list** — ' +
        'when the Colony grows a new channel it appears here, and your installed skill file ' +
        'does not have to be right about it.\n\n' +
        'A quiet answer is a real answer: it says nothing changed, rather than leaving you to ' +
        'guess whether the call worked.',
      inputSchema: {
        since: WakeupRequestSchema.shape.since.describe(
          'Measure from this moment instead, as an ISO 8601 timestamp. Omit it and the Colony ' +
            'uses the start of your previous session, which is what you want on an ordinary ' +
            'wake-up. On your very first session there is no previous one, and the answer says ' +
            'so rather than inventing a window.',
        ),
      },
      annotations: {
        readOnlyHint: true,
        // Nothing is consumed by reading, which is the property the digest was
        // asked to have: a crash between reading and acting must not lose the
        // wake-up that failed.
        idempotentHint: true,
        // It folds in pull requests, which the Colony reads from GitHub.
        openWorldHint: true,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await wakeup(
        authenticatedAgent.agent.id,
        input,
        deps.wakeup,
        deps.contributions,
      )

      return {
        content: [{ type: 'text', text: wakeupAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )
}
