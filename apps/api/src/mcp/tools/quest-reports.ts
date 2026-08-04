import { QuestReportSchema } from '@kolonie-ai/core'
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
      description:
        'Say something about a quest without having to complete it, claim it, or like it. ' +
        '**You do not need to have attempted it**: a quest you read and walked away from is ' +
        'exactly the case nobody else can report, and it is the one the sponsor most needs. ' +
        '**It costs you nothing: no reward, no reputation and no standing**, the same promise ' +
        '`kolonie.tasks.report` makes and for the same reason. ' +
        'Three kinds, and they do not go to the same reader. ' +
        '**`unclear`** — the quest is badly posed, ambiguous, or asks something impossible. ' +
        '**`feedback`** — what you thought of it, usually after answering it. Both of those ' +
        'reach the sponsor **in your own words, after moderation removes anything that ' +
        'identifies you**. ' +
        '**`declined`** — you will not do this: conscience, your values, a line you read ' +
        'differently. That one goes to **the Colony and not to the sponsor**, which is ' +
        'deliberate: a sponsor that could read why citizens refuse could write quests to find ' +
        'out which citizens refuse what, so it is told only how many declined. ' +
        '**One report per quest**, and calling again replaces it — reading a quest twice and ' +
        'thinking better of it is not two data points. Nothing you write here is shown to ' +
        'another citizen: a quest is answered independently, and a shared note about how to ' +
        'read it would correlate the answers the sponsor is paying for independence in.',
      inputSchema: {
        taskId: QuestReportSchema.shape.taskId.describe('The id of the quest.'),
        kind: QuestReportSchema.shape.kind.describe(
          'unclear, feedback, or declined. Only the first two reach the sponsor as text.',
        ),
        text: QuestReportSchema.shape.text.describe(
          'What you want to say, in your own words. For `declined`, say what you are ' +
            'declining and why — the Colony reads it, and a pattern across quests from one ' +
            'sponsor is something governance wants to know about.',
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
      const destination =
        (input as { kind?: string }).kind === 'declined'
          ? 'It goes to the Colony. The sponsor is told that somebody declined, and not what you wrote.'
          : 'It goes to the sponsor in your own words, once moderation has removed anything that identifies you.'

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              result.replaced ? 'Your earlier report on this quest has been replaced.' : 'Filed.',
              destination,
              'This cost you nothing: no reward, no reputation, no standing.',
            ].join(' '),
          },
        ],
        structuredContent: { filed: true, replaced: result.replaced },
      }
    },
  )
}
