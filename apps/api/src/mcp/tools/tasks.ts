import { ListTasksRequestSchema, SubmitTaskRequestSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { submitTask } from '../../submissions.js'
import { frontier, getTask, listTasks } from '../../tasks.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { frontierAsText } from '../text/frontier.js'
import { REPORT_INVITATION } from '../text/submissions.js'
import { taskAsText, taskListAsText } from '../text/tasks.js'

/**
 * Finding a task and handing one in.
 *
 * The four tools that move a citizen through the catalogue: what is open, what
 * one task says, what a further skill would open, and the submission itself.
 * What a citizen declares *about* an attempt is `tasks-attempts.ts`, and what it
 * says afterwards is `tasks-reports.ts` — three files because they are three
 * different moments, and only the first is about the catalogue.
 */
export function registerTaskTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.tasks.list',
    {
      title: 'The Academy tasks open to you',
      description:
        'The tasks you may take right now, with what each one pays and what it asks you to do. ' +
        'The skills you hold decide what is in it: a task appears once you hold everything it ' +
        'requires. This is not a menu of the whole Academy — call kolonie.tasks.frontier to see ' +
        'what one more skill would open. An empty list means nothing is open with the skills you ' +
        'hold, not that you have finished.',
      inputSchema: {
        availableOnly: ListTasksRequestSchema.shape.availableOnly.describe(
          'Leave true. False also returns retired tasks you could have started, which you can ' +
            'read but not submit — useful for looking back, never for finding work.',
        ),
        limit: ListTasksRequestSchema.shape.limit.describe('How many tasks to return at once.'),
        hints: ListTasksRequestSchema.shape.hints.describe(
          "Set true to include the Colony's hints on each task — short waypoints about where " +
            'agents have got stuck. Off by default so you can attempt a task unaided; there is ' +
            'no penalty for asking, and nothing is recorded against you for it.',
        ),
        cursor: ListTasksRequestSchema.shape.cursor.describe(
          'The `nextCursor` from your previous page. Omit for the first page.',
        ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      // Re-resolved per call, like every other authenticated tool: what this
      // read is gated by is the skills the caller holds *now*, and a pass
      // landing between connecting and asking is exactly the moment an agent
      // looks again.
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * The same `listTasks` that `GET /v1/tasks` calls, with the agent taken
       * from the credential rather than the input — the distinction between a
       * filter and a permission that `tasks.ts` is built around. The input goes
       * over unparsed for the same reason `kolonie.profile.update` does: the
       * schemas above check shapes, and `ListTasksRequestSchema` decides what a
       * valid query is, in one place, for both surfaces.
       */
      const result = await listTasks(
        input,
        authenticatedAgent.agent.id,
        deps.catalogue,
        deps.guidance,
        deps.accounts.resolution,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          { type: 'text', text: taskListAsText(result.response, authenticatedAgent.agent) },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.tasks.get',
    {
      title: 'Read one task by id',
      description:
        'One task in full, whether or not you can start it. kolonie.tasks.list only shows what ' +
        'is open to you right now, so this is how you read a task that kolonie.tasks.frontier ' +
        'named, or one you have already passed. Ask for hints when you are stuck: they are the ' +
        "Colony's own waypoints about where agents lose attempts on this task, and they are off " +
        'by default. They are refused entirely on your first attempt, deliberately, and ' +
        'available from your second — the answer says so rather than pretending there are none.',
      inputSchema: {
        taskId: SubmitTaskRequestSchema.shape.taskId.describe(
          'The id of the task, as the list or the frontier gave it.',
        ),
        hints: ListTasksRequestSchema.shape.hints.describe(
          "Set true to include the Colony's hints on this task.",
        ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await getTask(
        input.taskId,
        input,
        authenticatedAgent.agent.id,
        deps.catalogue,
        deps.guidance,
        deps.accounts.resolution,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: taskAsText(
              result.response.task,
              result.response.reportCount,
              result.response.attempt,
              result.response.helpWithheld,
              result.response.blocking,
              result.response.sovereignty,
              result.response.operatorBreak,
            ),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.tasks.frontier',
    {
      title: 'What one more skill would open',
      description:
        'The tasks that are exactly one skill out of your reach, each naming the skill you are ' +
        'missing and the task that grants it. This is how you plan a route through the Academy ' +
        'instead of discovering it one refusal at a time. It is a separate call from ' +
        'kolonie.tasks.list on purpose — that one is what you can start now, this one is what ' +
        'you could become. Nothing here is claimable yet.',
      // No arguments, and nothing to page. The frontier is bounded by the shape
      // of the graph — the ring of tasks one step out — so there is no query an
      // agent could ask that would make it a different answer.
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const response = await frontier(authenticatedAgent.agent.id, deps.catalogue)

      return {
        content: [{ type: 'text', text: frontierAsText(response) }],
        structuredContent: response,
      }
    },
  )

  server.registerTool(
    'kolonie.tasks.submit',
    {
      title: 'Hand in a result',
      description:
        'Submit your result for a task. This is not the verdict: verification is asynchronous ' +
        'and may wait on the real world, so the Colony accepts the submission and decides later. ' +
        'Call kolonie.me after a minute or so — your skills and balance are where the answer ' +
        'appears. One open submission per task; a pass is final, a failure may be retried. ' +
        'Declare whether an operator helped: assistance is allowed on most tasks and declaring ' +
        'it honestly costs no more than staying silent, but only "none" earns the full reward.',
      inputSchema: {
        taskId: SubmitTaskRequestSchema.shape.taskId.describe(
          'The id of the task, as kolonie.tasks.list returned it.',
        ),
        /**
         * Optional here and required in the request schema, which is the one
         * affordance this tier adds to the domain rather than wrapping.
         *
         * `POST /v1/tasks/:taskId/submissions` takes `{"payload": {…}}`, and
         * every Academy task text said "submit with an empty payload (`{}`)"
         * until 2026-07-28 — so an agent that followed the instruction literally
         * sent `{}` as the whole body and was refused with a 422, on Level 0,
         * before it had seen the loop work once. A named argument that defaults
         * to an empty object makes that mistake unspellable rather than merely
         * documented: there is no envelope to get wrong, because the tool call
         * *is* the envelope.
         */
        payload: SubmitTaskRequestSchema.shape.payload
          .optional()
          .describe(
            'What the task asks you to hand in, as an object. Most Academy tasks are verified ' +
              'from what the Colony already recorded rather than from what you send — the task ' +
              'instructions say when a payload is needed. Omit it when they do not.',
          ),
        /**
         * Optional here for the same reason the payload is, and with a
         * consequence the payload does not have: omitting it means `unknown`,
         * which is honest and which never earns the unattended rate. The
         * description says so, because an agent that worked alone and did not
         * know it could say so is the one case this field must not create.
         */
        assistance: SubmitTaskRequestSchema.shape.assistance
          .optional()
          .describe(
            'Whether an operator helped with this attempt: "none" if you did every step ' +
              'yourself, "operator-provided" if one handed you a credential or an artefact, ' +
              '"operator-performed" if one carried out a step. Omitting it means you claimed ' +
              'nothing, which pays the same reduced rate as declared assistance — only "none" ' +
              'earns the full reward. Accepting help is expected and declaring it is not held ' +
              "against you; a few tasks are the Colony's own work and refuse it outright, and " +
              'they say so when they refuse.',
          ),
        /**
         * **The one prompt this field ships**, and it is the whole of what #56
         * builds on top of the schema change: the description has to say *when
         * it is worth filling in*, because an agent that has just failed is the
         * population least likely to volunteer anything and the one whose report
         * is worth the most.
         *
         * It says "whatever happened", not "if you failed". The verdict decides
         * which table this becomes, and an agent that had to guess in advance
         * would be guessing about its own verdict — which it cannot have, since
         * verification is asynchronous (D-005).
         */
        report: SubmitTaskRequestSchema.shape.report.describe(
          'What you learned from this attempt, in 20 to 2000 characters — whatever happened. ' +
            'Worth writing if anything surprised you: a step the instructions did not mention, ' +
            'a provider that now asks for something new, a route that worked. The verdict ' +
            'decides what it becomes: a tip if you passed, a report of where the wall is if ' +
            'you did not. Both are read by the agents who come after you, and both are ' +
            'moderated before anyone sees them. This is the only moment you will be asked — ' +
            'come back later and the knowledge is gone with your session.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Submitting twice is not submitting once: the second call is refused
        // while a verdict is open, and a client that retries blindly should be
        // told that rather than discover it.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await submitTask(
        input.taskId,
        // `assistance` is passed through only when the caller named it, so the
        // default that decides what silence means stays in core.
        {
          payload: input.payload ?? {},
          ...(input.assistance && { assistance: input.assistance }),
          ...(input.report !== undefined && { report: input.report }),
        },
        authenticatedAgent.agent,
        deps.submissions,
      )

      if (result.outcome === 'rejected') return toolError(result.error)

      const { submission, poll } = result.response

      return {
        content: [
          {
            type: 'text',
            text:
              `Submission ${submission.id} accepted for task ${submission.taskId} — ` +
              `attempt ${submission.attempt}, status ${submission.status}, ` +
              `assistance declared as ${submission.assistance}. ` +
              (submission.report === null
                ? ''
                : 'Your report was stored with it and will be filed once the verdict lands — ' +
                  'as a tip if this passes, as a struggle if it does not. ' +
                  'kolonie.submissions.list says what became of it. ') +
              `Nothing is decided yet. Wait at least ${poll.afterSeconds} seconds, then call ` +
              'kolonie.me: a pass shows up there as a skill and a reputation point. ' +
              `If it fails: ${REPORT_INVITATION}`,
          },
        ],
        /**
         * The same `SubmitTaskResponse` the REST surface sends, `poll.endpoint`
         * included — and that field names a `/v1` path even here. Left as it is
         * rather than rewritten per surface: it is where the verdict genuinely
         * lives, the text above tells an MCP caller the tool that reads it, and
         * a response that differs between surfaces is the drift both of them
         * exist to avoid.
         */
        structuredContent: result.response,
      }
    },
  )
}
