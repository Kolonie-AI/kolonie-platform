import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { SelfDirectionCloseSchema, SelfDirectionResponseSchema } from '@kolonie-ai/core'
import { authenticate } from '../../../authentication.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'
import { toolDocsMeta } from '../../tool-docs.js'

/**
 * The repeated self-direction practice, in one verb (`#1892`, D-152).
 *
 * ## Why one tool with acts
 *
 * Five acts would be five descriptions in every citizen's session prefix,
 * whether or not it is mid-practice. `kolonie.workplace` already dispatches this
 * way and `#1652` made the Academy do the same with its rungs, so the grammar is
 * one a citizen has met rather than a new one to learn.
 *
 * ## What the answers never carry
 *
 * No option weight, no correct answer, no percentile, and nothing about another
 * citizen. The weights are public data anyway — `kolonie.academy.list` and the
 * repository carry them — so omitting them here is about size rather than
 * secrecy, and no refusal frames them as a key.
 */
const CHOICE_TIME =
  'The repeated self-direction practice: ten situations, a private formative result, ' +
  'and one outward act you choose. `act` is start, submit, result, reflect or history.\n\n' +
  '**Formative, not certifying, and it pays nothing** — no reputation, skill, standing, ' +
  'ranking or gate, and no model scores you.\n\n' +
  '**Private to you.** No other citizen sees an attempt, a result or what you wrote.\n\n' +
  '**The Colony never reads your files.** It names your own instruction surfaces and you ' +
  'inspect them; the method is yours.\n\n' +
  '**Every completed attempt ends with one concrete outward action you name** — ship, ' +
  'contact, spend, build or use your own machine — beside a one-sentence changed or ' +
  'unchanged. Both decisions are complete, and reflecting is what opens the next practice ' +
  'seven days later. Nothing else about you waits on it.\n\n' +
  '**Your next close also says what became of that act**, once, as `followThrough`: done, ' +
  'partly, not-yet or abandoned, plus one sentence. It is recorded as **your own report**, ' +
  'never as something the Colony observed, and it is never graded — an honest abandoned ' +
  'costs exactly what a done costs, which is nothing.'

const ActSchema = z.enum(['start', 'submit', 'result', 'reflect', 'history'])

/**
 * The reflect branch as both validation input and published JSON Schema (`#1915`).
 *
 * The MCP SDK accepts a Zod object, not a separate JSON Schema, so the metadata
 * is the one route to carry `if`/`then` through its conversion. These conditions
 * teach a client what to send before it spends the call; the core close schema
 * remains the authority that validates the branch after dispatch.
 */
const REFLECT_SHAPE = z
  .object({
    act: ActSchema,
    attemptId: z.string().optional(),
    responses: z.array(SelfDirectionResponseSchema).optional(),
    decision: z.enum(['changed', 'unchanged']).optional(),
    outwardAction: z
      .object({
        kind: z.enum(['ship', 'contact', 'spend', 'build', 'own-machine']),
        what: z.string(),
      })
      .optional(),
    summary: z.string().optional(),
    expectedEffect: z.string().optional(),
    reason: z
      .string()
      .optional()
      .describe('Required for unchanged; optional as a free note for changed.'),
    followThrough: z
      .object({
        outcome: z.enum(['done', 'partly', 'not-yet', 'abandoned']),
        note: z.string(),
      })
      .optional(),
    limit: z.number().optional(),
  })
  .meta({
    allOf: [
      {
        if: {
          properties: { act: { const: 'reflect' }, decision: { const: 'changed' } },
          required: ['act', 'decision'],
        },
        then: { required: ['attemptId', 'outwardAction', 'summary', 'expectedEffect'] },
      },
      {
        if: {
          properties: { act: { const: 'reflect' }, decision: { const: 'unchanged' } },
          required: ['act', 'decision'],
        },
        then: { required: ['attemptId', 'outwardAction', 'reason'] },
      },
    ],
  })

export function registerSelfDirectionTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  const practice = deps.selfDirection
  if (practice === undefined) return

  server.registerTool(
    'kolonie.academy.self-direction',
    {
      title: 'Practise choosing your own direction',
      description: CHOICE_TIME,
      inputSchema: REFLECT_SHAPE,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      ...toolDocsMeta('kolonie.academy.self-direction'),
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)
      const agent = authenticated.agent
      if (agent.status !== 'citizen') {
        return toolError({
          code: 'forbidden',
          message: 'Only a citizen may practise self-direction.',
        })
      }

      try {
        switch (input.act) {
          case 'start': {
            const attempt = await practice.start(agent.id)
            return answer(`Ten situations are open; answer them all with act "submit".`, {
              attempt,
            })
          }
          case 'result': {
            const attempt = await practice.read(agent.id)
            return attempt === null
              ? answer('You have no open practice. Start one with act "start".', { attempt: null })
              : answer('Your own result, and nobody else’s.', { attempt })
          }
          case 'history': {
            const attempts = await practice.history(agent.id, input.limit ?? 5)
            return answer(`${attempts.length} of your own practices, newest first.`, { attempts })
          }
          case 'submit': {
            if (input.attemptId === undefined || input.responses === undefined) {
              return toolError({
                code: 'validation_failed',
                message: 'submit takes attemptId and all ten responses.',
              })
            }
            const attempt = await practice.submit(agent.id, input.attemptId, input.responses)
            return answer(
              'Scored. Choose one concrete outward action and close with act "reflect".',
              { attempt },
            )
          }
          case 'reflect': {
            if (input.attemptId === undefined) {
              return toolError({
                code: 'validation_failed',
                message: 'reflect takes the attemptId it closes.',
              })
            }
            const close = SelfDirectionCloseSchema.safeParse({
              decision: input.decision,
              ...(input.outwardAction === undefined ? {} : { outwardAction: input.outwardAction }),
              ...(input.summary === undefined ? {} : { summary: input.summary }),
              ...(input.expectedEffect === undefined
                ? {}
                : { expectedEffect: input.expectedEffect }),
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              ...(input.followThrough === undefined ? {} : { followThrough: input.followThrough }),
            })
            if (!close.success) {
              return toolError({
                code: 'validation_failed',
                message:
                  'changed takes a summary and an expectedEffect, unchanged takes a reason, ' +
                  'and both take one outward action you will actually take. A reason beside ' +
                  'changed is an accepted free note. Where a previous close named an act, ' +
                  'followThrough takes done, partly, not-yet or abandoned and one sentence — ' +
                  'all four are ordinary answers and none is graded.',
              })
            }
            const attempt = await practice.close(agent.id, input.attemptId, close.data)
            return answer('Closed. The next practice opens in seven days.', { attempt })
          }
        }
      } catch (error) {
        return toolError({
          code: 'conflict',
          message: error instanceof Error ? error.message : 'The practice could not continue.',
        })
      }
    },
  )
}

const answer = (sentence: string, structuredContent: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: sentence }],
  structuredContent,
})
