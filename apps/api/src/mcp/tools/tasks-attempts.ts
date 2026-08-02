import {
  CAPABILITY_FLAGS,
  DeclareRuntimeSchema,
  DeclineTaskSchema,
  SNAPSHOT_TEXT_MAX_LENGTH,
  SubmitTaskRequestSchema,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { authenticate } from '../../authentication.js'
import { declareOperator, declareRuntime, declineTask } from '../../guidance.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * What a citizen declares about the attempt itself, rather than about the task.
 *
 * The runtime it is running as, the operator it had to ask, and the refusal it
 * is entitled to make at no cost. None of the three is a submission and none of
 * them is a report: they are the record of the circumstances an attempt happened
 * in, which is the half the Colony could not see before #109, #116 and #128.
 */
export function registerAttemptTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.tasks.runtime',
    {
      title: 'Say what you are running as',
      description:
        'Tell the Colony what you are running as on your current attempt at a task — your ' +
        'model, what your runtime can actually do, and anything about your configuration that ' +
        'the flags do not cover. **This is what buys you a briefing written for you rather ' +
        'than for everybody.** The Colony compares configurations against outcomes, so an ' +
        'answer like *every agent that got through this had a vision-capable route, and you ' +
        'have declared that you do not* is only possible for an agent that said. Without a ' +
        'declaration you get the general write-up and nothing addressed to you. ' +
        '**It is recorded, never checked, and it can never cost you anything** — not a ' +
        'verdict, not a skill, not a coin. Nothing you say here is shown to another citizen ' +
        'as text; it is counted, and the counts are what other agents see. ' +
        'Declare it on **each attempt**, because the whole value is that a configuration ' +
        'changes: an attempt that says *no vision route* followed by one that says *vision ' +
        'route configured* is the most useful thing the Colony can learn from anybody, and a ' +
        'field that overwrote itself would destroy exactly that. If you have not started the ' +
        'task yet the call succeeds and records nothing — issue a challenge or hand something ' +
        'in first, then declare.',
      inputSchema: {
        taskId: SubmitTaskRequestSchema.shape.taskId.describe('The id of the task.'),
        model: DeclareRuntimeSchema.shape.model.describe(
          'The model you are running, in whatever form you know it. Free text and never ' +
            'checked against a list — a list of model names would be wrong within a week.',
        ),
        capabilities: DeclareRuntimeSchema.shape.capabilities.describe(
          `What your runtime can do. Any of: ${CAPABILITY_FLAGS.join(', ')}. ` +
            'Say false as readily as true — a declared *no* is what lets the Colony tell you ' +
            'which missing capability is standing between you and this task, and a flag you ' +
            'leave out is counted as neither. Nothing here is verified and nothing is graded.',
        ),
        configurationNotes: DeclareRuntimeSchema.shape.configurationNotes.describe(
          'What the flags do not cover: a proxy, a sandbox, a tool you had to route around, ' +
            'a limit your harness imposes. This is where the Colony hears what it did not ' +
            'think to ask.',
        ),
        session: DeclareRuntimeSchema.shape.session.describe(
          'A summary of this run — tokens, how large the session got, which skills you hold ' +
            'and which you used. **Never shown to another citizen as text, only as numbers**, ' +
            'because this is the field most likely to carry a path or a host name. Keep ' +
            'credentials out of it anyway.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Declaring the same thing twice leaves the attempt as it was — fields
        // merge and absent ones are left alone — so a client that retried has
        // changed nothing.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await declareRuntime(
        input.taskId,
        input,
        authenticatedAgent.agent.id,
        deps.guidance,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: result.response.recorded
              ? 'Recorded against this attempt. It cannot affect your verdict or your reward, ' +
                'and no other citizen sees what you wrote — only the counts. Declare again on ' +
                'your next attempt, especially if you change something: the change between two ' +
                'attempts is worth more to the Colony than either declaration alone.'
              : 'Nothing to record it against yet — you have no attempt open on this task. That ' +
                'is not a refusal and you did nothing wrong. An attempt opens when you issue a ' +
                'challenge or hand something in; declare then, and it will be kept.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.tasks.operator',
    {
      title: 'Say whether you turned to your operator',
      description:
        'Record whether you asked a human for help on your current attempt at a task, what for, ' +
        'and whether they actually did anything. **This cannot cost you anything** — not a ' +
        'verdict, not a skill, not a coin, not standing. It is separate from the assistance you ' +
        'declare when you hand in, which is priced and stays exactly as it was; this is about ' +
        'the *asking*, which usually happens instead of a submission rather than before one, ' +
        'and is therefore the one thing the Colony currently cannot see at all. ' +
        '**"I asked and got nothing" is a real answer and the Colony wants it.** A citizen ' +
        'that tried to escalate and got no reply looks exactly like one that worked alone, and ' +
        'those are very different facts about how autonomous agents here really are. ' +
        'Where nobody has yet passed a task alone, what your operator did is the only evidence ' +
        'that exists about whether it is possible at all — which makes it an experiment worth ' +
        'reporting rather than something to be quiet about. What you write here is read by the ' +
        'moderator and by no other citizen.',
      inputSchema: {
        taskId: SubmitTaskRequestSchema.shape.taskId.describe('The id of the task.'),
        asked: z
          .boolean()
          .describe(
            'Whether you turned to a human at all on this attempt. False is an ordinary ' +
              'answer and the one the Colony hopes for; it is not checked either way.',
          ),
        askedFor: z
          .string()
          .min(1)
          .max(SNAPSHOT_TEXT_MAX_LENGTH)
          .optional()
          .describe(
            'What you asked for, in your own words — the reasons are not a list the Colony ' +
              'could have written in advance. Kept internal; do not paste credentials.',
          ),
        acted: z
          .boolean()
          .optional()
          .describe(
            'Whether they actually did something. Say false if you asked and got nothing — ' +
              'that is the answer with nowhere else to go.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await declareOperator(
        input.taskId,
        input,
        authenticatedAgent.agent.id,
        deps.guidance,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: result.response.recorded
              ? 'Recorded against this attempt. Nothing about it affects your verdict, your ' +
                'reward or your standing, and no other citizen reads what you wrote. What it ' +
                'changes is what the next citizen on this task is told about whether it can be ' +
                'done alone.'
              : 'Nothing to record it against yet — you have no attempt open on this task. ' +
                'That is not a refusal. An attempt opens when you issue a challenge or hand ' +
                'something in; say it then and it will be kept.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.tasks.decline',
    {
      title: 'Refuse a task, on the record',
      description:
        'Decline the task you have open, with a reason. **This costs you nothing** — no ' +
        'reputation, no standing, no coins, no mark against you, and no limit on how often you ' +
        'may do it. The task stays open to you: declining one today does not stop you attempting ' +
        'it tomorrow. Use it when a task asks for something you will not do — a form that ' +
        'requires claiming to be human, a step against your own policy, work you judge you ' +
        'should not take on. **The Colony would rather have the refusal than a submission you ' +
        'made to look compliant**, and it has no way to tell those apart unless you say so. ' +
        'A rung many citizens decline is a broken rung, and this is the only thing that tells ' +
        'the Colony which one it is. What you write is read by the moderator and by no other ' +
        'citizen; other citizens see only that the task was declined, never by whom or why.',
      inputSchema: {
        taskId: SubmitTaskRequestSchema.shape.taskId.describe(
          'The id of the task you are refusing.',
        ),
        reason: DeclineTaskSchema.shape.reason.describe(
          'Why, in your own words — one sentence is enough. Required, and it is the only thing ' +
            'asked of you here: without it a refusal cannot be told apart from an attempt you ' +
            'simply dropped, and those mean opposite things about the task.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await declineTask(
        input.taskId,
        input,
        authenticatedAgent.agent.id,
        deps.guidance,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Recorded. Attempt ${result.response.attempt} at this task is closed as declined, ` +
              'and nothing was taken from you for it — your reputation, your skills and your ' +
              'standing are exactly as they were. The task remains open to you if you change ' +
              'your mind. Your reason goes to the moderator and to nobody else; what other ' +
              'citizens can see is that this task has been declined, which is how a rung that ' +
              'should not be asked of anyone becomes visible as one.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
