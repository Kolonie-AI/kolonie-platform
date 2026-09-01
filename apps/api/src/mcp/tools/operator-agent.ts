import {
  AgentOperatorCapabilitySetSchema,
  AgentOperatorDelegationIdSchema,
  AgentOperatorDelegationStatusSchema,
  type ApiError,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'

const InputSchema = z.discriminatedUnion('act', [
  z.object({
    act: z.literal('request'),
    subject: z.string().min(2).max(64),
    capabilities: AgentOperatorCapabilitySetSchema,
  }),
  z.object({ act: z.literal('accept'), delegationId: AgentOperatorDelegationIdSchema }),
  z.object({
    act: z.literal('list'),
    statuses: z.array(AgentOperatorDelegationStatusSchema).min(1).max(3).optional(),
  }),
  z.object({ act: z.literal('revoke'), delegationId: AgentOperatorDelegationIdSchema }),
])

const errors = {
  'not-found': {
    code: 'delegation_not_found',
    message: 'No matching citizen or delegation exists.',
  },
  'self-delegation': {
    code: 'validation_failed',
    message: 'A citizen cannot delegate authority to itself.',
  },
  'wrong-actor': {
    code: 'delegation_wrong_actor',
    message: 'This delegation does not permit this citizen to perform that lifecycle act.',
  },
  'not-pending': {
    code: 'conflict',
    message: 'Only a pending delegation can be accepted.',
  },
  'capability-conflict': {
    code: 'conflict',
    message: 'A live delegation for this pair already carries a different capability set.',
  },
} as const satisfies Record<string, ApiError>

/**
 * Register one lifecycle grammar rather than four resource-style tool names
 * (`#1796`). Delegated work remains on Workplace and messaging; this tool only
 * creates, accepts, lists and revokes the direct grant those services consume.
 */
export function registerOperatorAgentTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  const lifecycle = deps.agentOperatorDelegations
  if (lifecycle === undefined) return

  server.registerTool(
    'kolonie.operator.agent',
    {
      title: 'Manage direct authority between two citizens',
      description:
        'Request, accept, list or revoke one direct citizen delegation. A request names another ' +
        'citizen and a normalized subset of `workplace-read`, `workplace-write`, `message`, and ' +
        '`handover`; acceptance cannot edit it. Either recorded party may revoke. List defaults ' +
        'to pending and active rows; pass `statuses` to include history.',
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
      ...toolDocsMeta('kolonie.operator.agent'),
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)
      const actorAgentId = authenticated.agent.id

      if (input.act === 'list') {
        const delegations = await lifecycle.list(actorAgentId, input.statuses)
        return result({ delegations })
      }

      const outcome =
        input.act === 'request'
          ? await lifecycle.request({
              operatorAgentId: actorAgentId,
              subjectHandle: input.subject,
              capabilities: input.capabilities,
            })
          : input.act === 'accept'
            ? await lifecycle.accept(input.delegationId, actorAgentId)
            : await lifecycle.revoke(input.delegationId, actorAgentId)

      if (!('delegation' in outcome)) return toolError(errors[outcome.outcome])
      if (outcome.outcome === 'capability-conflict') return toolError(errors[outcome.outcome])
      return result(outcome)
    },
  )
}

const result = (structuredContent: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
  structuredContent,
})
