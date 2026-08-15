import { QuestEndingSchema, TaskIdSchema, type AgentId, type ApiError } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { endQuest, type QuestResult } from '../../quests.js'
import { UNPRIVILEGED } from '../../routes/privileged.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The steward's side of the quest surface, over MCP (`#320`).
 *
 * **Registered only for a caller that holds `steward`**, which is D-013's rule
 * rather than a new one: tiers are built by registering fewer tools, not by
 * refusing more. A sponsor shown a tool whose only possible answer is a refusal
 * spends context on it, and the credential has already been resolved by the time
 * the list is built — so the role is in hand and costs no second lookup.
 *
 * The refusal still exists underneath. `authenticate` plus the role check guards
 * these, because a tool that is merely *unlisted* is not a tool that is
 * *unreachable*: an agent that learned the name elsewhere may still call it.
 *
 * **What is not here any more is publication** (`#723`). A quest that clears
 * moderation is published by that verdict (`#693`), so `kolonie.quests.review`,
 * `.publish` and `.refuse` were deleted along with the queue behind them.
 *
 * **And what is not here any more is the reading** (`#944`). The sampling audit
 * and the held-report queue were both queues — work drawn one item at a time,
 * on a cadence, with a verdict that a model can reach as well as a person. A
 * queue that only advances when somebody calls a tool is a queue that stops when
 * nobody does, and the audit is the number the Colony uses to decide whether to
 * keep publishing paid quests at all. Both now run in `apps/moderation-runner`
 * on a poll.
 *
 * **One tool is left, and it is left deliberately.** `kolonie.quests.end` stops
 * a live quest that is spending money, and stopping it has to be immediate
 * rather than next-poll. That is the whole difference: a lever is not a queue.
 * Every use of it is filed as a maintainer issue by the runner
 * (`quest-endings.ts`), so a tier of one tool is still a tier somebody audits.
 */

function answer<T>(result: QuestResult<T>, sentence: (response: T) => string) {
  if (result.outcome === 'rejected') return toolError(result.error)

  return {
    content: [{ type: 'text' as const, text: sentence(result.response) }],
    structuredContent: result.response as Record<string, unknown>,
  }
}

export function registerQuestStewardTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * Resolve the caller and confirm the role, in one place.
   *
   * The role is checked here rather than trusted from the tier that registered
   * these tools: the tier decides what is *offered*, and this decides what is
   * *allowed*. One of those may be wrong without the other being.
   *
   * **`UNPRIVILEGED` and not a message of its own.** `privileged.ts` gives the
   * reason and it holds on this surface unchanged: any variation is an oracle,
   * and a refusal that differed between *you hold no roles* and *you hold the
   * wrong one* would say how close somebody is.
   */
  const steward = async (): Promise<{ id: AgentId } | { error: ApiError }> => {
    const authenticated = await authenticate(credential, deps.store)
    if (authenticated.outcome === 'rejected') return { error: authenticated.error }
    if (!authenticated.agent.roles.includes('steward')) return { error: UNPRIVILEGED }
    return { id: authenticated.agent.id }
  }

  server.registerTool(
    'kolonie.quests.end',
    {
      title: 'End a live quest, with a reason citizens read',
      description:
        'Take a live quest out of circulation when the Colony should not keep offering it. ' +
        '**The reason is required and published verbatim** to citizens reading the retired ' +
        'quest. New citizens cannot start it; citizens already holding a live attempt keep ' +
        'that attempt and may still hand in, and accepted answers and their payments are not ' +
        'disturbed. The response states what happened to the sponsor’s payment. ' +
        '**Every use is filed as an issue a maintainer reads** — this is the one privileged ' +
        'tool the tier holds, and it is audited rather than trusted.',
      inputSchema: {
        questId: TaskIdSchema.describe('The id of the live quest to end.'),
        reason: QuestEndingSchema.shape.reason.describe(
          'Why the Colony is ending it, in a sentence citizens can understand.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ questId, reason }) => {
      const caller = await steward()
      if ('error' in caller) return toolError(caller.error)

      return answer(
        await endQuest(
          {
            actorId: caller.id,
            questId,
            body: { reason },
            at: new Date().toISOString(),
            stewarding: true,
          },
          deps.quests,
        ),
        (ended) => ended.notice,
      )
    },
  )
}
