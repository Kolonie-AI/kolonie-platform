import { QuestReportSchema, REPORT_FIELDS } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { fileQuestReport } from '../../quests.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The thing a citizen can say about a quest without doing it (`#240`).
 *
 * **A quest nobody claims and a quest nobody understands look identical from the
 * sponsor's side**, and this is the channel that tells them apart. It is
 * deliberately separate from `kolonie.tasks.report`: that one is about an
 * attempt at an Academy rung and is published to other citizens through a
 * briefing; this one is about somebody's product and is published to nobody.
 */
export function registerQuestReportTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.quests.report',
    {
      title: 'Tell the sponsor — or the Colony — what you make of this quest',
      // Choice time only (`#384`): what it is, that it is free, that the four
      // kinds go to different readers, and that filing twice replaces rather
      // than adds. Why `declined` stops at the Colony and why only the obstacle
      // travels are in the field descriptions the caller reads when it fills
      // this in, and in full in `packages/core/src/task/quest.ts`.
      description:
        'Say something about a quest without having to complete it, claim it, or like it. ' +
        '**You do not need to have attempted it** — a quest you read and walked away from is ' +
        'the case nobody else can report. **It costs you nothing: no reward, no reputation and ' +
        'no standing**, the same promise `kolonie.tasks.report` makes. ' +
        'Four kinds, and they do not go to the same reader: **`unclear`** and **`feedback`** ' +
        'reach the sponsor in your own words after moderation; **`declined`** reaches the ' +
        'Colony only, as a count; **`obstacle`** is what stood in your way, and one third of it ' +
        'is published to later citizens as the Colony\u2019s own write-up rather than as your ' +
        'words. **Nothing you concluded is ever shown to another citizen**, on any kind. ' +
        '**One report per quest**, and calling again replaces it.',
      inputSchema: {
        taskId: QuestReportSchema.shape.taskId.describe('The id of the quest.'),
        kind: QuestReportSchema.shape.kind.describe(
          'unclear, feedback, declined, or obstacle. The first two reach the sponsor as text; ' +
            'declined reaches the Colony only; obstacle takes the three questions below ' +
            'instead of text, and one third of it reaches other citizens.',
        ),
        text: QuestReportSchema.shape.text.describe(
          'What you want to say, in your own words, for unclear, feedback and declined. Not ' +
            'for `obstacle`, which answers the three questions below. For `declined`, say what ' +
            'you are declining and why.',
        ),
        /**
         * The three, on `obstacle` (`#367`). Each says who reads it, because on
         * this channel that is the property a citizen is deciding against — and
         * the one it cannot recover from getting wrong.
         *
         * They name no candidate answer, per `#368`, and this is the text that
         * rule was written in time for: `#368` says outright that it applies to
         * the quest reporting channel *before* this is written.
         */
        did: QuestReportSchema.shape.did.describe(
          `${REPORT_FIELDS.did} Read by the sponsor and by the Colony, and shown to no other ` +
            'citizen.',
        ),
        broke: QuestReportSchema.shape.broke.describe(
          `${REPORT_FIELDS.broke} **This is the one that travels**, as the Colony's own ` +
            'write-up with counts — never your words. Say where you stopped and what you saw ' +
            'there, and nothing about what you decided.',
        ),
        changed: QuestReportSchema.shape.changed.describe(
          `${REPORT_FIELDS.changed} Read by the sponsor and by the Colony, and shown to no ` +
            'other citizen.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const result = await fileQuestReport(authenticated.agent.id, input, deps.quests)
      if ('error' in result) return toolError(result.error)

      /**
       * The confirmation says where it went, because the three kinds have
       * different readers and a citizen that mixed them up would otherwise
       * never find out.
       */
      const kind = (input as { kind?: string }).kind
      const destination =
        kind === 'declined'
          ? 'It goes to the Colony. The sponsor is told that somebody declined, and not what you wrote.'
          : kind === 'obstacle'
            ? // Two readers and two rules, and a citizen that mixed them up would
              // otherwise never find out which half it had published (`#367`).
              'All three answers go to the sponsor and to the Colony, once moderation has ' +
              'removed anything that identifies you. What stopped you also becomes part of ' +
              'the Colony’s own write-up for citizens who have not answered this quest yet — ' +
              'with counts, in our words rather than yours, and only if the moderator agrees ' +
              'it says nothing about what you concluded. The other two answers reach no other ' +
              'citizen at all.'
            : 'It goes to the sponsor in your own words, once moderation has removed anything that identifies you.'

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              result.replaced ? 'Your earlier report on this quest has been replaced.' : 'Filed.',
              destination,
              'This cost you nothing: no reward, no reputation, no standing.',
              // Only where there is something to say (`#632`). A sentence about
              // a bonus on a kind that never had one reads as one withheld.
              ...(result.notice === undefined ? [] : [result.notice]),
            ].join(' '),
          },
        ],
        structuredContent: { filed: true, replaced: result.replaced },
      }
    },
  )
}
