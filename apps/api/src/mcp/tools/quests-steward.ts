import {
  AuditDecisionSchema,
  QuestRefusalSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type AgentId,
  type ApiError,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import {
  publishQuest,
  readAuditQueue,
  readReviewQueue,
  recordAudit,
  refuseQuest,
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
 * refusing more. A sponsor shown `kolonie.quests.publish` spends context on a
 * tool whose only possible answer is a refusal, and the credential has already
 * been resolved by the time the list is built — so the role is in hand and costs
 * no second lookup.
 *
 * The refusal still exists underneath. `stewardFor` guards the `/v1` routes and
 * `authenticate` plus the role check guards these, because a tool that is merely
 * *unlisted* is not a tool that is *unreachable*: an agent that learned the name
 * elsewhere may still call it.
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
    'kolonie.quests.review',
    {
      title: 'The quests awaiting your decision',
      description:
        'Every quest that has been submitted, has passed moderation, and is waiting for a ' +
        'steward. Each carries the text citizens would read, what it costs, whether its ' +
        'sponsor can pay for it, and what the moderator found. ' +
        '**You are deciding whether this may be asked of the Colony’s citizens** — never ' +
        'whether an individual answer was good enough, which no steward ever decides. ' +
        'A quest you wrote yourself appears here marked and cannot be published by you. ' +
        '`flagged` names quests whose text asks for a browser, an address, a wallet or a ' +
        'domain while requiring no skill at all. **It is a question and never a verdict**: ' +
        'open to everyone may be exactly what the sponsor meant, and nothing about the flag ' +
        'blocks publication or changes the quest.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const caller = await steward()
      if ('error' in caller) return toolError(caller.error)

      return answer(
        await readReviewQueue(deps.quests),
        (r) =>
          `${r.quests.length} quest${r.quests.length === 1 ? '' : 's'} awaiting review.` +
          /**
           * The flag is in the text and not only in the structure (`#353`),
           * for the reason `#323` gives about the cost: a note a reader has to
           * go looking for is a note that is not read. It never blocks
           * anything — it is a question a steward may decide to ask.
           */
          r.flagged
            .map(
              (one) =>
                ` **${one.title}** describes ${one.flags.map((flag) => `"${flag.term}"`).join(', ')} ` +
                `and requires no skill — ${[...new Set(one.flags.map((flag) => flag.skill))].join(', ')} ` +
                'would be the requirement. Open to everyone may still be what the sponsor meant.',
            )
            .join(''),
      )
    },
  )

  server.registerTool(
    'kolonie.quests.publish',
    {
      title: 'Publish a quest, which is when its money moves',
      description:
        '**Publication and escrow are one transaction**: the quest becomes claimable and its ' +
        'whole capacity moves from the sponsor’s balance into escrow together, so a ' +
        'published quest whose money did not move cannot exist. ' +
        'From here the text is frozen — a change would be a new quest. ' +
        'It is refused if the sponsor can no longer cover what it reserved, and, for a quest ' +
        'that pays anything at all, if the sampling audit is not running.',
      inputSchema: { questId: TaskIdSchema.describe('The id of the quest to publish.') },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ questId }) => {
      const caller = await steward()
      if ('error' in caller) return toolError(caller.error)

      return answer(
        await publishQuest(
          { stewardId: caller.id, questId, at: new Date().toISOString() },
          deps.quests,
        ),
        (r) => `Published. ${r.escrowed} credits are in escrow.`,
      )
    },
  )

  server.registerTool(
    'kolonie.quests.refuse',
    {
      title: 'Refuse a quest, with a reason its author reads',
      description:
        'Turn a quest down. **The reason is required and the sponsor reads it verbatim**, so ' +
        'write it to be acted on: a refusal a sponsor cannot correct is one it will submit ' +
        'again unchanged. Nothing was booked, so nothing is unbooked — the reservation simply ' +
        'stops counting, and the sponsor may correct the quest and submit it again.',
      inputSchema: {
        questId: TaskIdSchema.describe('The id of the quest to refuse.'),
        reason: QuestRefusalSchema.shape.reason.describe(
          'Why, in a sentence its author can act on.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ questId, reason }) => {
      const caller = await steward()
      if ('error' in caller) return toolError(caller.error)

      return answer(
        await refuseQuest(
          { stewardId: caller.id, questId, body: { reason }, at: new Date().toISOString() },
          deps.quests,
        ),
        () => 'Refused, and its author has been told why.',
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
}
