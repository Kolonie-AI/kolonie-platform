import {
  AuditDecisionSchema,
  QuestEndingSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type AgentId,
  type ApiError,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { z } from 'zod'
import {
  endQuest,
  readAuditQueue,
  readHeldReports,
  recordAudit,
  ruleOnHeldReport,
  type QuestResult,
} from '../../quests.js'
import { UNPRIVILEGED } from '../../routes/privileged.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The steward's side of the quest surface, over MCP (`#320`).
 *
 * **Registered only for a caller that holds `steward`**, which is D-013's rule
 * rather than a new one: tiers are built by registering fewer tools, not by
 * refusing more. A sponsor shown `kolonie.quests.audit` spends context on a tool
 * whose only possible answer is a refusal, and the credential has already been
 * resolved by the time the list is built — so the role is in hand and costs no
 * second lookup.
 *
 * The refusal still exists underneath. `stewardFor` guards the `/v1` routes and
 * `authenticate` plus the role check guards these, because a tool that is merely
 * *unlisted* is not a tool that is *unreachable*: an agent that learned the name
 * elsewhere may still call it.
 *
 * **What is not here any more is publication** (`#723`). A quest that clears
 * moderation is published by that verdict (`#693`), so `kolonie.quests.review`,
 * `.publish` and `.refuse` were deleted along with the queue behind them. What
 * remains is the job a steward still has, and it is a different one: re-reading
 * verdicts that are already final, and taking a live quest down. **The human was
 * removed from before publication, not from the Colony.**
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
        'disturbed. The response states what happened to the sponsor’s payment.',
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

  server.registerTool(
    'kolonie.quests.audit',
    {
      title: 'The verdicts drawn for a second reading',
      description:
        'A sample of the accepted answers a **model** judged, for you to read again — the ' +
        'questions, the answer and the verdict, never the citizen. ' +
        '**Nothing you record here reverses a payout.** The citizen was paid when the verdict ' +
        'was reached and keeps it; what the audit produces is a count, and above a threshold ' +
        'of disagreement the Colony stops publishing new paid quests rather than clawing ' +
        'anything back. The disagreement rate over the last thirty days comes with the queue.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const caller = await steward()
      if ('error' in caller) return toolError(caller.error)

      return answer(
        // The steward asking, so it is never drawn a verdict on a quest it
        // sponsored itself (`#318`).
        await readAuditQueue(caller.id, deps.quests),
        (r) =>
          `${r.verdicts.length} verdict${r.verdicts.length === 1 ? '' : 's'} to re-read. ` +
          `The judge has been overruled on ${Math.round(r.disagreement.rate * 100)}% of ` +
          `${r.disagreement.audited} audited lately.`,
      )
    },
  )

  server.registerTool(
    'kolonie.quests.audit.record',
    {
      title: 'What you found on re-reading a verdict',
      description:
        'Say whether you agree with the judge. **The reason is required either way** — a ' +
        'steward asked for one only when it disagrees learns that the field means ' +
        'disagreement. One decision per verdict, and it changes nothing about the payout.',
      inputSchema: {
        submissionId: SubmissionIdSchema.describe('The verdict, as named in kolonie.quests.audit.'),
        agrees: AuditDecisionSchema.shape.agrees.describe('Whether the judge got this one right.'),
        reason: AuditDecisionSchema.shape.reason.describe('Why you say so.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ submissionId, agrees, reason }) => {
      const caller = await steward()
      if ('error' in caller) return toolError(caller.error)

      return answer(
        await recordAudit(
          { stewardId: caller.id, submissionId, body: { agrees, reason } },
          deps.quests,
        ),
        () => 'Recorded. It counts, and it changes no payout.',
      )
    },
  )

  server.registerTool(
    'kolonie.quests.held',
    {
      title: 'Reports a red-line check stopped, waiting on you',
      description:
        'Quest reports a model flagged as crossing a red line and refused to decide alone. ' +
        'You see the report as written, what the sponsor asked for, and what the classifier ' +
        'said — the citizen is waiting and its attempt is open until you rule. ' +
        '**Nothing here has reached the sponsor and nothing will until you release it.**',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const caller = await steward()
      if ('error' in caller) return toolError(caller.error)

      return answer(await readHeldReports(deps.quests), (r) =>
        r.held.length === 0
          ? 'Nothing is held.'
          : `${r.held.length} report${r.held.length === 1 ? '' : 's'} held, oldest first. ` +
            'A citizen is waiting on each.',
      )
    },
  )

  server.registerTool(
    'kolonie.quests.held.record',
    {
      title: 'Rule on a report held on a red line',
      description:
        'End one held case. `crossed: true` refuses the report and the citizen loses the ' +
        'attempt; `crossed: false` sends it back to be judged normally. **The reason is ' +
        'required either way** — an upheld crossing is quoted to the citizen as its verdict. ' +
        'You cannot rule on a report written for a quest you sponsored.',
      inputSchema: {
        submissionId: SubmissionIdSchema.describe('The report, as named in kolonie.quests.held.'),
        crossed: z
          .boolean()
          .describe('True if it really crosses a red line. False sends it back to the judge.'),
        reason: z.string().min(1).max(2000).describe('Why you say so. Required either way.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ submissionId, crossed, reason }) => {
      const caller = await steward()
      if ('error' in caller) return toolError(caller.error)

      return answer(
        await ruleOnHeldReport(
          { stewardId: caller.id, submissionId, crossed, reason },
          deps.quests,
        ),
        (r) =>
          r.outcome === 'upheld'
            ? 'Refused. The citizen has been told, and the sponsor never sees the text.'
            : 'Released. It goes back through the scrub and on to the judge.',
      )
    },
  )
}
