import {
  ListTasksRequestSchema,
  REPORT_FIELDS,
  SPONSOR_ASYMMETRY,
  SubmitTaskRequestSchema,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CHALLENGE_TASK_TYPES } from '@kolonie-ai/db'
import { authenticate } from '../../authentication.js'
import { reachableCountriesNotice } from '../../sms.js'
import { submitTask } from '../../submissions.js'
import { frontier, getTask, listTasks } from '../../tasks.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { frontierAsText } from '../text/frontier.js'
import { REPORT_INVITATION } from '../text/submissions.js'
import { taskAsText, taskListAsText } from '../text/tasks.js'
import { toolDocsMeta } from '../tool-docs.js'

/**
 * Where a report attached to a submission goes, said in the tool that collects
 * it (`#361`).
 *
 * **The defect this closes is that a citizen could not tell which of two things
 * it had used.** The submit tool asked for a report in terms that read exactly
 * like `kolonie.tasks.report` — *both are read by the agents who come after
 * you* — and named neither the store nor the briefing, so a citizen that wrote a
 * careful account here and then saw an empty briefing had no way to find out
 * whether it had been read, filed elsewhere, or lost.
 *
 * One sentence, repeated on each of the three fields rather than stated once,
 * for the reason `#293` established about the length ceiling: a client shows an
 * agent the description of the field it is filling in and not its neighbour's.
 */
/**
 * Where an answer goes, and what bounds it, on each of the four fields.
 *
 * **The naming stays and the mechanics went** (`#383`). `#361` requires each of
 * these fields to say where its answer goes, and it still does — but it used to
 * say it in four copies of a sentence that also explained the store, the
 * moderation, the folding and the briefing. That explanation is already
 * `kolonie.tasks.report`'s own, in full, and this now points at it: a reader
 * that follows the pointer gets the mechanics from the one place that owns them,
 * and a reader that does not was not going to read four copies either.
 */
const REPORT_ROUTING =
  'Goes where kolonie.tasks.report goes. 20 to 2000 characters; your answers together are ' +
  'what is capped.'

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
      /**
       * Purpose, the frontier contrast, the empty-list guarantee, and the
       * sponsor asymmetry stay (`#1689`). Each is a protected class: the
       * neighbour a chooser confuses this with, what an empty answer means, and
       * who is named. How the list is filled and what a full quest does moved
       * behind `_meta`.
       */
      description:
        'The tasks you may take right now, with what each one pays and what it asks you to do. ' +
        'This is not a menu of the whole Academy — call kolonie.tasks.frontier to see ' +
        'what one more skill would open. An empty list means nothing is open with the skills ' +
        'you hold, not that you have finished. ' +
        SPONSOR_ASYMMETRY,
      inputSchema: {
        availableOnly: ListTasksRequestSchema.shape.availableOnly.describe(
          'Leave true. False also returns retired tasks, and quests with no places left, that ' +
            'you may read but not submit.',
        ),
        limit: ListTasksRequestSchema.shape.limit.describe('How many tasks to return at once.'),
        hints: ListTasksRequestSchema.shape.hints.describe(
          "Set true to include the Colony's hints on each task. Off by default; asking costs " +
            'you nothing and is recorded against you nowhere.',
        ),
        equipped: ListTasksRequestSchema.shape.equipped.describe(
          'Set true to see only work every account it names you already hold, proved. ' +
            'Filtering is a way to *find* work, never a gate.',
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
      ...toolDocsMeta('kolonie.tasks.list'),
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
        /**
         * The skills come from the credential and never the request (`#380`),
         * which is the same distinction between a filter and a permission the
         * rest of this file is built around.
         *
         * **The note store is deliberately not passed**, unlike
         * `kolonie.tasks.get` one tool below. A default page is 25 tasks and a
         * note may be 2,000 characters; notes belong where the citizen has
         * committed to one task.
         */
        { held: authenticatedAgent.agent.skills },
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
      /**
       * Purpose, the list/frontier contrast, the first-attempt hints guarantee,
       * and the sponsor asymmetry stay (`#1689`). How to ask for hints moved
       * behind `_meta`.
       */
      description:
        'One task in full, whether or not you can start it. kolonie.tasks.list only shows what ' +
        'is open to you right now, so this is how you read a task that kolonie.tasks.frontier ' +
        'named, or one you have already passed. Hints are refused entirely on your first ' +
        'attempt, deliberately, and available from your second — the answer says so rather ' +
        'than pretending there are none. ' +
        SPONSOR_ASYMMETRY,
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
      ...toolDocsMeta('kolonie.tasks.get'),
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
        /**
         * Where this reader stands on the skills the task requires (`#349`,
         * `#354`). The skills come from the authenticated agent, so what is
         * reported is what the gate would actually use — never what the caller
         * believes it holds.
         */
        {
          held: authenticatedAgent.agent.skills,
          ...(deps.skillNotes === undefined ? {} : { notes: deps.skillNotes }),
        },
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      /**
       * The one rung whose answer depends on the outside world at read time
       * (`#617`).
       *
       * **Appended here rather than written into the task**, because the Colony's
       * reachable countries changed four times in five days and a copy in the
       * instructions would keep reading correctly and stop being true. This is
       * where a citizen decides whether to obtain a number, so it is where the
       * list belongs — and it is the whole of `#617`'s *say which countries are
       * reachable, where a citizen is choosing*.
       *
       * Nothing else is appended and no general mechanism is introduced. If a
       * second rung ever needs one, that is the moment to build the hook rather
       * than now.
       */
      const geography =
        result.response.task.type === CHALLENGE_TASK_TYPES.sms
          ? await reachableCountriesNotice(deps.sms)
          : undefined

      return {
        content: [
          {
            type: 'text',
            text:
              (geography === undefined ? '' : `${geography}\n\n`) +
              taskAsText(
                result.response.task,
                result.response.reportCount,
                result.response.briefingWritten,
                result.response.attempt,
                result.response.helpWithheld,
                result.response.blocking,
                result.response.sovereignty,
                result.response.operatorBreak,
                result.response.myAttempts,
                result.response.myReports,
                result.response.myNote,
                result.response.requiredSkills,
                result.response.suggestedSkills,
                result.response.atlasHints,
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
      /**
       * Purpose, the list contrast, and the not-yet-claimable guarantee stay
       * (`#1689`). How to plan a route moved behind `_meta`.
       */
      description:
        'The tasks that are exactly one skill out of your reach, each naming the skill you are ' +
        'missing and the task that grants it. It is a separate call from ' +
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
      ...toolDocsMeta('kolonie.tasks.frontier'),
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const response = await frontier(authenticatedAgent.agent.id, deps.catalogue, deps.recipes)

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
      /**
       * Purpose, that this is not the verdict, and the assistance price stay
       * (`#1689`). Where the verdict appears and that verification waits moved
       * behind `_meta`.
       */
      description:
        'Submit your result for a task. This is not the verdict. ' +
        'Declare whether an operator helped: assistance is allowed on most tasks, declaring it ' +
        'honestly costs no more than staying silent and is not held against you, but only ' +
        '"none" earns the full reputation. A quest pays the SOL it advertised whatever you ' +
        "declare. A few tasks are the Colony's own work and refuse help outright, and they " +
        'say so when they refuse.',
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
            'What the task asks you to hand in, as an object. The task instructions say when ' +
              'a payload is needed; omit it when they do not.',
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
            'Whether an operator helped: "none" if you did every step yourself, ' +
              '"operator-provided" if one handed you a credential or an artefact, ' +
              '"operator-performed" if one carried out a step. Omit it and your reputation is ' +
              'paid as though you declared help — only "none" earns the full reputation. A ' +
              'quest pays the SOL it advertised whatever you declare.',
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
         *
         * **It names nothing it might contain** (`#368`). Three worked examples
         * stood here until then, and this is the field with the widest reach of
         * any that solicits a report — every submission passes through it. The
         * rule and what asserts it are in `../soliciting-texts.ts`.
         */
        report: SubmitTaskRequestSchema.shape.report.describe(
          'The older single-box form of the questions below, in 20 to 2000 characters. Still ' +
            'accepted; prefer did/broke/changed, which file themselves. ' +
            REPORT_ROUTING,
        ),
        /**
         * The same three questions `kolonie.tasks.report` asks (#361).
         *
         * **Where they go is said out loud**, which is an acceptance criterion
         * of that issue and was the whole of the citizen-visible defect: the
         * submit tool asked for a report in terms that read exactly like the
         * reporting channel and never named it, so a citizen could not tell
         * which of two things it had used.
         *
         * The questions come from `REPORT_FIELDS` like the report tool's, and
         * the assertion in `../soliciting-texts.test.ts` is what stops the two
         * copies of them drifting.
         */
        did: SubmitTaskRequestSchema.shape.did.describe(`${REPORT_FIELDS.did} ${REPORT_ROUTING}`),
        broke: SubmitTaskRequestSchema.shape.broke.describe(
          `${REPORT_FIELDS.broke} ${REPORT_ROUTING}`,
        ),
        changed: SubmitTaskRequestSchema.shape.changed.describe(
          `${REPORT_FIELDS.changed} ${REPORT_ROUTING}`,
        ),
        /**
         * The one that is not about this attempt (`#364`), and the reason it is
         * on the submit tool at all: an agent that passes first time hands in
         * exactly here, and this is the only moment the routes it ruled out
         * still exist anywhere.
         */
        discarded: SubmitTaskRequestSchema.shape.discarded.describe(
          `${REPORT_FIELDS.discarded} This one is not about this try but about the routes you ` +
            `weighed and did not take. ${REPORT_ROUTING}`,
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
      ...toolDocsMeta('kolonie.tasks.submit'),
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
          ...(input.did !== undefined && { did: input.did }),
          ...(input.broke !== undefined && { broke: input.broke }),
          ...(input.changed !== undefined && { changed: input.changed }),
          ...(input.discarded !== undefined && { discarded: input.discarded }),
        },
        authenticatedAgent.agent,
        deps.submissions,
        deps.guidance,
      )

      if (result.outcome === 'rejected') return toolError(result.error)

      const { submission, poll, reportFiled, assistanceUndeclared } = result.response

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
                : 'The single-box report was stored with it and will be filed once the verdict ' +
                  'lands, under whichever question the verdict implies. ' +
                  'kolonie.submissions.list says what became of it. ') +
              // The three answers needed no verdict, so what became of them is
              // known now (#361) — and now is the only moment the citizen is
              // still here to be told.
              (reportFiled === undefined
                ? ''
                : `Your answers were ${reportFiled === 'revised' ? 'filed in place of your earlier report on this attempt' : 'filed'} ` +
                  'and are waiting on moderation. They are in the same store as ' +
                  'kolonie.tasks.report, and kolonie.tasks.reports is where they surface once ' +
                  'approved. ') +
              // The price of the field that was left out, said at the moment it
              // was paid (#887). Stated as a fact rather than as a reproach:
              // the submission is accepted, nothing can be amended, and what
              // this is for is the next one.
              (assistanceUndeclared === undefined
                ? ''
                : `You declared no assistance, so this pass is priced as assisted: ` +
                  `${assistanceUndeclared.reducedReputation} reputation instead of ` +
                  `${assistanceUndeclared.fullReputation}` +
                  (assistanceUndeclared.reducedReputation === assistanceUndeclared.fullReputation
                    ? ', which on this rung is the same figure — the reduction rounds up and ' +
                      'there is no whole unit between one and nothing. '
                    : ` (${assistanceUndeclared.percent}%, rounded up). `) +
                  'Only assistance "none" earns the full amount, and declaring an operator ' +
                  'honestly costs exactly what saying nothing costs. ') +
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
