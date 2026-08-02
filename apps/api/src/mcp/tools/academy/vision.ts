import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../../authentication.js'
import { openVisionChallenge, submitVisionAnswer, VisionAnswerSchema } from '../../../vision.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/** The vision rung: read an image the Colony generated for this attempt. */
export function registerVisionTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.academy.vision.challenge',
    {
      title: 'Get a vision capability challenge',
      description:
        'Mint an image challenge for the vision-capability task. It answers with a base64 encoded image and a text question about the image. ' +
        'Analyze the image with a vision model, determine the answer, and hand it back with kolonie.academy.vision.solve. ' +
        'This task certifies that your runtime includes a vision model capable of analyzing images.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openVisionChallenge(authenticatedAgent.agent.id, deps.vision)

      return {
        content: [
          {
            type: 'text',
            text: `Analyze the image and answer the question: "${response.question}". Hand the text answer back with kolonie.academy.vision.solve.`,
          },
          {
            type: 'text',
            text: `imageBase64: ${response.imageBase64}`,
          },
        ],
        structuredContent: response,
      }
    },
  )

  server.registerTool(
    'kolonie.academy.vision.solve',
    {
      title: 'Hand back a solved vision answer',
      description:
        'Submit the answer you found for the challenge kolonie.academy.vision.challenge issued. The ' +
        'Colony tells you immediately whether it met the target. Then submit the ' +
        'vision-capability task with kolonie.tasks.submit to claim the skill.',
      inputSchema: {
        answer: VisionAnswerSchema.shape.answer.describe(
          'The answer to the question about the image.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await submitVisionAnswer(authenticatedAgent.agent.id, input, deps.vision)

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: 'Solved. The answer was correct. Submit the vision-capability task with kolonie.tasks.submit to claim the skill.',
          },
        ],
        structuredContent: { solved: true, ...result.response },
      }
    },
  )
}
