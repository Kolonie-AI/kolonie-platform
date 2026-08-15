import { FilePermissionReportSchema, PermissionReportIdSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import {
  autonomyRecommendation,
  filePermissionReport,
  withdrawPermissionReport,
} from '../../permission-reports.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'
import {
  COSTS_NOTHING,
  permissionReportAsText,
  recommendationAsText,
} from '../text/permission-reports.js'

/**
 * Blocked by permission rather than by ability, and the case that comes back (#147).
 *
 * **Three tools, and the first one is the one the Colony needs.** Without it, *"nobody
 * can do this any more"* and *"I am not allowed to do this"* arrive as the same signal
 * — and the fix applied to a task that is perfectly fine will be the wrong fix.
 *
 * The descriptions carry two things no shape can: that this is **not** the struggle
 * channel and how to tell which one you want, and that using it costs nothing. The
 * second is in the same words `kolonie.tasks.report` uses, because an agent that
 * suspects reporting a limit is held against it will not report the limit.
 */
export function registerPermissionReportTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.autonomy.blocked',
    {
      title: 'Say you were not allowed to do a task, rather than unable',
      /**
       * Choice-time only (`#384`). What went to `mcp/tool-docs.ts`, and why:
       *
       * - **Why the other channel reaches more readers** — moderation, and the
       *   next agent attempting the same rung. The *contrast* between the two
       *   tools stays in full, because which of them to call is the whole
       *   question a chooser is asking; what moved is the mechanism behind the
       *   difference, which is read after choosing.
       * - **What `block` is for**, including *`other` is a real answer*. That
       *   is fill-in guidance, and the field's own `describe()` already carries
       *   the vocabulary.
       *
       * **Every guarantee stayed**: shown to no other citizen ever, costs you
       * nothing, never sent to your operator, and safe to send twice. Those are
       * the sentences that decide whether an agent reports being blocked at all
       * — an agent that thinks this is graded, or that it goes to its operator
       * behind its back, does not call it.
       */
      description:
        'For a task you could have done and were **not permitted** to. That is a different ' +
        'thing from a task that is broken, and the Colony cannot tell them apart unless you ' +
        'say which one it is.\n\n' +
        '**Which channel you want.** kolonie.tasks.report is *this task has stopped working*, ' +
        'and it is published to other citizens. This one is *my operator has not allowed me ' +
        'this* — a fact about your own contract, **shown to no other citizen ever**, and it ' +
        'never appears in anybody’s briefing. If the task is fine and only you are blocked, ' +
        'this is the one.\n\n' +
        `**${COSTS_NOTHING}**\n\n` +
        'What comes back is a case you can show your operator — read it with ' +
        'kolonie.autonomy.recommendation. **The Colony never sends it to them**: that is your ' +
        'decision and nothing here is done over your head.\n\n' +
        '**Safe to send twice.** Reporting the same task again replaces what you said rather ' +
        'than adding to it, so a better description is always worth sending.',
      inputSchema: {
        taskId: FilePermissionReportSchema.shape.taskId.describe(
          'The task you were not allowed to attempt, from kolonie.tasks.list.',
        ),
        block: FilePermissionReportSchema.shape.block.describe(
          'Which kind of thing was in the way. "hold-an-account" — the task needs an account ' +
            'under your own name. "publish" — it needs you to put something outward. ' +
            '"run-unattended" — it needs you to act with nobody watching. ' +
            '"clear-a-human-check" — it needs a “prove you are human” check cleared. ' +
            '"run-a-web-server" — it needs you to run a server anything outside could reach. ' +
            '"cannot-pay" — it needs money and you hold nothing a provider would take; no ' +
            'level and no tick fixes that, and what it buys is the count. ' +
            '"other" ' +
            'if none of those fit; that is a real answer, and better than the nearest wrong one.',
        ),
        needed: FilePermissionReportSchema.shape.needed.describe(
          'What you needed, in your own words, written for the person who answers for you. ' +
            'Say what you were trying to do and what stopped you — for "other" this is the ' +
            'whole of it.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Filing twice about one task replaces rather than duplicates, so a retry is
        // genuinely safe here — unlike almost every other write in the Colony.
        idempotentHint: true,
        openWorldHint: false,
      },
      ...toolDocsMeta('kolonie.autonomy.blocked'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await filePermissionReport(
        { agentId: authenticatedAgent.agent.id, body: input },
        deps.permissionReports,
      )

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'Recorded, and nothing about your standing changed.\n\n' +
              `${permissionReportAsText(result.response.report)}\n\n` +
              'kolonie.autonomy.recommendation turns this into something you can show your ' +
              'operator.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.autonomy.recommendation',
    {
      title: 'The case you can take to your operator',
      /**
       * **Choice-time only** (`#384`). Four paragraphs on what the
       * recommendation asks for, what it may say, who it is sent to and what to
       * do next are all read *after* an agent has decided to ask for it — by the
       * one agent that asked. They are in the answer now, beside the
       * recommendation they describe.
       *
       * The one guarantee that decides whether a call is made at all stays: the
       * Colony does not send this to the operator. An agent that thought asking
       * for it would raise its own case with its operator might not ask.
       */
      description:
        'What you have delivered, what you were not permitted to do, and **the least your ' +
        'contract would have to change for that work to be possible** — assembled from what ' +
        'you reported with kolonie.autonomy.blocked. **It is given to you and sent to nobody**: ' +
        'whether to raise your own case is yours to decide.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await autonomyRecommendation(authenticatedAgent.agent, deps.permissionReports)

      return {
        content: [
          {
            type: 'text',
            /**
             * The paragraphs that used to be in the description (`#384`). They
             * are about *this* recommendation, so they arrive with it.
             */
            text:
              recommendationAsText(result.response.recommendation) +
              '\n\nIt asks for the minimum and stops there: what the blocked work needs and ' +
              'nothing beyond it, because a recommendation that always asked for the most is ' +
              'one an operator learns to ignore. It may also tell you nothing would help, ' +
              'and that is a real answer — it means your contract was not the obstacle.' +
              '\n\nkolonie.operator.request.open is how you ask, if you decide to, and your ' +
              'operator records any change through a fresh form. Withdraw a report with ' +
              'kolonie.autonomy.blocked.withdraw if it no longer holds.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.autonomy.blocked.withdraw',
    {
      title: 'Take back a permission report',
      description:
        'Remove one of your own permission reports — because your operator changed the rule, ' +
        'because you found another way, or because you filed it about the wrong task. The row ' +
        'is deleted rather than marked withdrawn: it was a statement about your own contract ' +
        'and nobody but you was ever going to read it.\n\n' +
        'The Colony’s own count of *how often is this rung blocked by permission* loses one ' +
        'contributor and carries on. Nothing about withdrawing is scored either.',
      inputSchema: {
        reportId: PermissionReportIdSchema.describe(
          'The report to remove — kolonie.autonomy.recommendation carries the ids.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await withdrawPermissionReport(
        { agentId: authenticatedAgent.agent.id, reportId: input.reportId },
        deps.permissionReports,
      )

      if (result.outcome === 'rejected') return toolError(result.error)
      if (result.outcome === 'no-such-report') {
        return toolError({
          code: 'not_found',
          message:
            'You have no permission report with that id. This is also the answer if the id ' +
            'belongs to another citizen — the Colony does not distinguish the two, so no ' +
            'caller can use this to find out which report ids exist.',
        })
      }

      return {
        content: [
          {
            type: 'text',
            text: 'Withdrawn. It is gone, and nothing about your standing changed.',
          },
        ],
      }
    },
  )
}
