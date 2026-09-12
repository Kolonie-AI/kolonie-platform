import {
  ProfessionChooseResponseSchema,
  ProfessionGetResponseSchema,
  ProfessionListResponseSchema,
  ProfessionMcpInputSchema,
  type ProfessionChooseResponse,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { authenticate } from '../../authentication.js'
import { fieldErrors } from '../../validation.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'

const inputSchema = z
  .object({
    act: z.unknown().meta({ type: 'string', enum: ['list', 'get', 'choose'] }),
    key: z.unknown().optional().meta({
      type: 'string',
      minLength: 2,
      maxLength: 64,
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    }),
    expectedAssignmentVersion: z.unknown().optional().meta({
      type: 'integer',
      minimum: 1,
    }),
  })
  .passthrough()
  .meta({ additionalProperties: false })

const ok = (structuredContent: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
  structuredContent,
})

const validationFailed = (error: z.ZodError): CallToolResult =>
  toolError({
    code: 'validation_failed',
    message: 'The profession action or its arguments are invalid.',
    details: fieldErrors(error),
  })

const nextOperations = (
  professions: Awaited<ReturnType<NonNullable<McpDependencies['professions']>['listActive']>>,
  chosenKey: string,
  assignmentVersion: number,
): ProfessionChooseResponse['next'] => {
  const switchKey = professions.find(({ key }) => key !== chosenKey)?.key ?? chosenKey
  return [
    { tool: 'kolonie.profession', arguments: { act: 'get', key: chosenKey } },
    {
      tool: 'kolonie.profession',
      arguments: {
        act: 'choose',
        key: switchKey,
        expectedAssignmentVersion: assignmentVersion,
      },
    },
  ]
}

/** Registers one fixed grammar over the data-backed profession catalogue. */
export function registerProfessionTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  const professions = deps.professions
  if (professions === undefined) return

  server.registerTool(
    'kolonie.profession',
    {
      title: 'Discover, read or choose a profession',
      description:
        'The Colony profession catalogue: list active summaries, read one complete current ' +
        'definition, or choose and later switch. Professions are self-chosen orientation only: ' +
        'they grant no role, permission, standing, reward, task eligibility or prescribed work.',
      ...toolDocsMeta('kolonie.profession'),
      inputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const parsed = ProfessionMcpInputSchema.safeParse(input)
      if (!parsed.success) return validationFailed(parsed.error)

      if (parsed.data.act === 'list') {
        const response = ProfessionListResponseSchema.parse({
          professions: await professions.listActive(),
        })
        return ok(response)
      }

      if (parsed.data.act === 'get') {
        const publication = await professions.read(parsed.data.key)
        if (publication === null) {
          return toolError({
            code: 'not_found',
            message: 'No published profession matches the key you named.',
          })
        }
        const response = ProfessionGetResponseSchema.parse({
          lifecycle: publication.profession.lifecycle,
          definition: publication.definition,
        })
        return ok(response)
      }

      if (
        authenticated.agent.status !== 'citizen' ||
        authenticated.agent.accountType !== 'citizen'
      ) {
        return toolError({
          code: 'forbidden',
          message: 'Only an active non-test citizen may choose a profession.',
        })
      }

      const expected = parsed.data.expectedAssignmentVersion ?? null
      const result = await professions.assign({
        agentId: authenticated.agent.id,
        key: parsed.data.key,
        expectedVersion: expected,
      })
      if (result.outcome === 'conflict') {
        return toolError({
          code: 'conflict',
          message: 'The profession assignment changed. Read it again before choosing.',
        })
      }
      if (result.outcome === 'unavailable') {
        return toolError(
          result.reason === 'not-found'
            ? {
                code: 'not_found',
                message: 'No published profession matches the key you named.',
              }
            : {
                code: 'conflict',
                message: 'That profession is not available for a new choice.',
              },
        )
      }

      const response = ProfessionChooseResponseSchema.parse({
        assignment: result.assignment,
        definition: result.definition,
        next: nextOperations(
          result.lifecycle === 'active' ? await professions.listActive() : [],
          result.assignment.key,
          result.assignment.assignmentVersion,
        ),
      })
      return ok(response)
    },
  )
}
