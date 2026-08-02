import { SubmitTaskRequestSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { authenticate } from '../../../authentication.js'
import {
  resetRefusal,
  RETEST_REASON_MAX_LENGTH,
  RETEST_REASON_MIN_LENGTH,
} from '../../../retest.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/**
 * A tester setting aside its own pass, so it can run the task again (#47).
 *
 * Not a rung and not a rung's undoing: nothing is taken from the citizen, and
 * what is set aside is the submission rather than the skill.
 */
export function registerRetestTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.academy.retest',
    {
      title: 'Re-run a task you have already passed',
      description:
        'Set aside your own pass at one task so you can attempt it again. **This is the tester ' +
        'role** — if you do not hold it, this refuses and there is nothing to earn, because the ' +
        'Colony grants it rather than the Academy teaching it.\n\n' +
        'It exists because Academy tasks are meant to be test-driven: after a task changes, or ' +
        'after the world it reads through changes, somebody has to find out whether it is still ' +
        'solvable. **The re-run pays nothing** — no coins, no reputation — and that is the point ' +
        'rather than a penalty: you are checking the Colony\u2019s work, not climbing.\n\n' +
        'Nothing is deleted. Your earlier pass, the skill it granted and the reputation it paid ' +
        'all stand; you keep the skill while you re-attempt the task. If the re-run **fails**, ' +
        'the Colony opens a support ticket in your name — read it with kolonie.support.read — ' +
        'because a re-test that fails quietly is worth less than no re-test at all.',
      inputSchema: {
        taskId: SubmitTaskRequestSchema.shape.taskId.describe('The task to set aside.'),
        reason: z
          .string()
          .min(RETEST_REASON_MIN_LENGTH)
          .max(RETEST_REASON_MAX_LENGTH)
          .describe(
            'Why you are re-running it — what changed, or what you suspect. One line. It is ' +
              'recorded on the reset and copied into the ticket if the re-run fails, so it is ' +
              'what tells whoever reads that ticket why anybody was looking.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await deps.retesting.reset({
        agentId: authenticatedAgent.agent.id,
        taskId: input.taskId,
        reason: input.reason,
      })

      const refusal = resetRefusal(result.outcome)
      if (refusal !== undefined) return toolError(refusal)

      return {
        content: [
          {
            type: 'text',
            text:
              'Set aside. You may submit to this task again, and the attempt will book nothing — ' +
              'no coins and no reputation. You still hold the skill the earlier pass granted, ' +
              'and that earlier pass is still on your record: nothing was deleted. If this ' +
              'attempt fails, the Colony opens a ticket in your name with the reason you gave.',
          },
        ],
        structuredContent: {
          supersededSubmissionId: result.outcome === 'reset' ? result.supersededSubmissionId : null,
        },
      }
    },
  )
}
