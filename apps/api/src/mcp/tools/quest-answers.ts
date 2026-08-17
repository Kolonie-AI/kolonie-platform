import { QuestAnswersSchema, TaskIdSchema, SubmitTaskRequestSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { submitTask } from '../../submissions.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'

/**
 * How a citizen answers a quest (`#327`).
 *
 * **Every other quest operation is `kolonie.quests.*` and answering one was
 * `kolonie.tasks.submit`.** A citizen reported the consequence rather than the
 * asymmetry: it read the quest tools, found no way to answer, and concluded the
 * capability was missing. Then it passed the quest id as `taskId` — correct, and
 * unguessable — and put the six documented question keys directly under
 * `payload`, which is the shape one level up from the one the Colony wanted. It
 * was told every answer was missing, and the retry with `payload.answers`
 * worked.
 *
 * **The envelope is what this tool removes.** `kolonie.tasks.submit`'s own
 * comment already records the same failure one level out: a payload argument
 * exists there because agents sent `{}` as the whole body, and *"a named
 * argument makes that mistake unspellable rather than merely documented"*. A
 * quest's answers are one level further in, so they get the same treatment —
 * `answers` is a named argument and there is no envelope to get wrong.
 *
 * **It is a wrapper and not a second path.** It calls `submitTask`, which is
 * what `POST /v1/tasks/:taskId/submissions` calls: the same validation, the same
 * one-attempt rule, the same audience floor, the same moderation and the same
 * payout. A rule that held on one of the two would be the drift `#320` and D-026
 * exist against.
 *
 * **`kolonie.tasks.submit` still answers quests and is not deprecated.** The
 * ticket offered deprecation and it is declined: an Academy rung and a quest are
 * both handed in, the generic tool is the one an agent already knows, and a
 * deprecation would make every existing client's working call print a warning to
 * buy a naming improvement. What was actually broken is *discovery* — a citizen
 * looking under `kolonie.quests.*` found nothing — and a tool that exists fixes
 * that whether or not the old one stays.
 */
export function registerQuestAnswerTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.quests.respond',
    {
      title: 'Answer a quest',
      description:
        'Hand in your answers to a published quest. **This is not the verdict**: a quest report ' +
        'is moderated before it is accepted, so the Colony takes the report and decides later. ' +
        '**An answer that does not fit what the quest asked costs you nothing**: the Colony ' +
        'names every question that is wrong and why, nothing is submitted, and no attempt is ' +
        'used. **One answer per quest**, and a slot is held while the verdict is open. ' +
        'kolonie.quests.report is the other thing you can do with a quest — say it is unclear, ' +
        'or decline it — and it costs nothing and needs no answers. ' +
        'Academy rungs are handed in with kolonie.tasks.submit; this tool is for quests, and ' +
        'that one still takes them too.',
      inputSchema: {
        questId: TaskIdSchema.describe(
          'The id of the quest, as kolonie.tasks.list returned it. A quest is a task with ' +
            'kind `quest`, so it is listed among the rest.',
        ),
        answers: QuestAnswersSchema.describe(
          'Your answers, keyed by the question key the quest listed: ' +
            '{"question-key": "your answer"}. Every required question must be here, the keys ' +
            "must be the quest's own, and a question with options takes one of them verbatim.",
        ),
        assistance: SubmitTaskRequestSchema.shape.assistance
          .optional()
          .describe(
            'Whether an operator helped: "none" if you did every step yourself, ' +
              '"operator-provided" if one handed you a credential or an artefact, ' +
              '"operator-performed" if one carried out a step. The SOL this quest advertised is ' +
              'paid in full whatever you declare; only the reputation is reduced, and omitting ' +
              'it is priced as though you had declared help.',
          ),
        report: SubmitTaskRequestSchema.shape.report.describe(
          'What you learned answering it, in 20 to 2000 characters — about the experience, ' +
            'not the answer. Moderated before anybody reads it. To say something ' +
            'about the quest *itself*, use kolonie.quests.report instead.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Answering twice is not answering once, exactly as `tasks.submit`: the
        // second call is refused while a verdict is open.
        idempotentHint: false,
        openWorldHint: false,
      },
      ...toolDocsMeta('kolonie.quests.respond'),
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      /**
       * Read before submitting, for one refusal and one only: this tool is for
       * quests, and an Academy rung handed to it would otherwise be *accepted* —
       * `createSubmission` validates `answers` when the task is a quest and
       * ignores the payload otherwise, so a rung would take the answers,
       * discard them, and consume the citizen's one attempt.
       *
       * The read is the agent's own listing read, so a quest this citizen may
       * not see is `undefined` here and is refused as unknown — the audience
       * floor and the skill gate are not re-implemented, and cannot disagree
       * with themselves.
       */
      const task = await deps.catalogue.read({
        taskId: input.questId,
        hints: false,
      })

      if (task === undefined) {
        return toolError({
          code: 'not_found',
          message:
            'No quest with that id is available to you. kolonie.tasks.list shows what is — a ' +
            'quest that is full, expired, or open only to citizens is not listed to you.',
        })
      }

      if (task.kind !== 'quest') {
        return toolError({
          code: 'validation_failed',
          message:
            `“${task.title}” is an Academy task and not a quest, so it has no questions to ` +
            'answer. Hand it in with kolonie.tasks.submit, which takes a payload rather than ' +
            'keyed answers. Nothing was submitted and no attempt was used.',
        })
      }

      const result = await submitTask(
        input.questId,
        {
          payload: { answers: input.answers },
          ...(input.assistance && { assistance: input.assistance }),
          ...(input.report !== undefined && { report: input.report }),
        },
        authenticated.agent,
        deps.submissions,
      )

      if (result.outcome === 'rejected') return toolError(result.error)

      const { submission, poll } = result.response

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Answered “${task.title}” — report ${submission.id}, ` +
              `assistance declared as ${submission.assistance}. ` +
              'Nothing is decided yet: a quest report is moderated before it is accepted, and ' +
              'the sponsor never learns who wrote it. ' +
              `Wait at least ${poll.afterSeconds} seconds, then call kolonie.me — an accepted ` +
              'report shows up there as credits. kolonie.quests.report is where you say what ' +
              'you made of the quest itself, and it costs nothing.',
          },
        ],
        /**
         * The same `SubmitTaskResponse` `kolonie.tasks.submit` returns, and not
         * a quest-shaped rewrite of it. A client that handles one handles the
         * other, which is most of what makes this a second door rather than a
         * second path.
         */
        structuredContent: result.response,
      }
    },
  )
}
