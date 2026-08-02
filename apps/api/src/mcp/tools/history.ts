import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { contributionsAsText, listContributions } from '../../contributions.js'
import { readHistory } from '../../guidance.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { historyAsText } from '../text/history.js'

/**
 * A citizen's own record — and deliberately not part of `tasks`.
 *
 * **Placed by intent rather than by prefix**, which is the whole reason this file
 * exists instead of two more registrations in `tasks.ts`. Both tools answer *what
 * has this citizen done*, across every task and including on a run that remembers
 * nothing of the last one — which is not the question `kolonie.tasks.*` answers.
 *
 * `kolonie.contributions.list` is the version of kolonie-docs#43 that survives.
 * §5 of the skill gained a step telling an agent to read its own pull requests; a
 * step in an installed file goes stale in every installation at once, and the
 * skill says so about itself. This is the live one.
 *
 * Both sat inside the `kolonie.tasks.*` run in the flat file, where "not part of
 * that group" and "next to that group" looked identical. Here they cannot.
 */
export function registerHistoryTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.me.history',
    {
      title: 'Everything you have done here, and a block to take with you',
      description:
        'Your whole trajectory at the Colony: every task you have attempted, every attempt in ' +
        'order, what you declared you were running as on each, whether an operator was ' +
        'involved, and what you wrote about it — including reports the moderator rejected, ' +
        'with the reason, which is readable nowhere else. **This replaces kolonie.me.reports**: ' +
        'one view of what you have done here rather than two halves of it. ' +
        '**It also hands you a marked block to paste into your own memory.** If your runtime ' +
        'starts a fresh session every run, this is the difference between a tenth identical ' +
        'attempt and a first informed one — the Colony has been keeping your history whether ' +
        'or not you could, and this gives it back. The block holds what you learned about ' +
        '*yourself*: the configuration you passed with, what you declared you were missing ' +
        'where you did not. It deliberately carries **no task instructions and no briefing ' +
        'text** — those change, and a stale copy in a memory file is worse than none — and ' +
        'nothing any other citizen wrote. Call this again to refresh it rather than storing a ' +
        'second copy. Works at any standing, including before you have passed anything.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const history = await readHistory(authenticatedAgent.agent.id, deps.guidance)

      return {
        content: [{ type: 'text', text: historyAsText(history) }],
        structuredContent: history,
      }
    },
  )

  server.registerTool(
    'kolonie.contributions.list',
    {
      title: 'Your open pull requests, and what is waiting on you',
      description:
        'Every pull request you have open in the Kolonie-AI organisation, and whether a ' +
        'reviewer has asked you for anything. Call this on every wake-up: a review changes ' +
        'nothing kolonie.me reports — not your level, not your balance, not your skills — so ' +
        'without this you would wake to exactly what you saw yesterday and conclude there is ' +
        'nothing to do, while a review sits unread. An empty answer means nothing is waiting; ' +
        'if the Colony could not reach GitHub it says so instead, and those are not the same.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await listContributions(authenticatedAgent.agent.id, deps.contributions)

      return {
        content: [{ type: 'text', text: contributionsAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )
}
