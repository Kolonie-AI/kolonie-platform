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

/**
 * One flat object rather than a union on `act` (`#1964`).
 *
 * ## Why the published shape is flat
 *
 * A `z.discriminatedUnion` root converts to `{ oneOf: [ … ] }`, and Anthropic's
 * tool-use API refuses `oneOf`, `allOf` or `anyOf` at the top level of an
 * `input_schema` — before inference, naming the whole request, so one such tool
 * makes the entire catalogue unusable on that API. Measured 2026-09-13: eight
 * consecutive `400`s from a client carrying the Kolonie toolset.
 *
 * **And the union published nothing anyway.** The MCP SDK collapsed this root to
 * `{"type":"object","properties":{}}`, so every argument — `act` included — was
 * invisible to a caller reading the schema. Flattening is what makes the five
 * fields discoverable at all; the wire-compatibility fix and the usability fix
 * are the same edit.
 *
 * `academy/answers.ts` is the precedent and records the same trade: the schema is
 * flat, the contract is in the handler, and what a flat shape gives up — a caller
 * cannot be *stopped* by the schema from sending `statuses` to `revoke` — is
 * bought back by a refusal that names the act and what that act takes.
 */
const InputSchema = {
  act: z
    .enum(['request', 'accept', 'list', 'revoke'])
    .describe('Which lifecycle act: request, accept, list or revoke.'),
  subject: z
    .string()
    .min(2)
    .max(64)
    .optional()
    .describe('request: the citizen to delegate to, by handle.'),
  capabilities: AgentOperatorCapabilitySetSchema.optional().describe(
    'request: the subset of `workplace-read`, `workplace-write`, `message` and `handover` to grant.',
  ),
  delegationId: AgentOperatorDelegationIdSchema.optional().describe(
    'accept / revoke: which delegation.',
  ),
  statuses: z
    .array(AgentOperatorDelegationStatusSchema)
    .min(1)
    .max(3)
    .optional()
    .describe('list: which statuses to return. Omit for pending and active.'),
}

/** What each act requires, for a refusal that names it rather than a schema error. */
const REQUIRED_BY_ACT = {
  request: ['subject', 'capabilities'],
  accept: ['delegationId'],
  list: [],
  revoke: ['delegationId'],
} as const satisfies Record<string, readonly string[]>

/**
 * The per-act contract the flat schema cannot state.
 *
 * Returns the refusal, or `undefined` when the act has what it needs. The message
 * names the act and its arguments, because a model that sent the wrong set needs
 * to know which set was right.
 */
const missingArgument = (
  input: Readonly<Record<string, unknown>>,
  act: keyof typeof REQUIRED_BY_ACT,
): ApiError | undefined => {
  const missing = REQUIRED_BY_ACT[act].filter((field) => input[field] === undefined)
  if (missing.length === 0) return undefined

  const takes = REQUIRED_BY_ACT[act]
  return {
    code: 'validation_failed',
    message:
      `${missing.join(', ')} ${missing.length === 1 ? 'is required' : 'are required'} for act ` +
      `"${act}", which takes ${takes.length === 0 ? 'no arguments' : takes.join(', ')}. ` +
      'Nothing was changed.',
  }
}

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

      // The published schema no longer states which act takes what, so the
      // handler does — before anything is read or written.
      const refusal = missingArgument(input, input.act)
      if (refusal !== undefined) return toolError(refusal)

      if (input.act === 'list') {
        const delegations = await lifecycle.list(actorAgentId, input.statuses)
        return result({ delegations })
      }

      const outcome =
        input.act === 'request'
          ? await lifecycle.request({
              operatorAgentId: actorAgentId,
              // Narrowed by `missingArgument` above, which the compiler cannot see
              // through: the flat shape types every branch field as optional.
              subjectHandle: input.subject as NonNullable<typeof input.subject>,
              capabilities: input.capabilities as NonNullable<typeof input.capabilities>,
            })
          : input.act === 'accept'
            ? await lifecycle.accept(
                input.delegationId as NonNullable<typeof input.delegationId>,
                actorAgentId,
              )
            : await lifecycle.revoke(
                input.delegationId as NonNullable<typeof input.delegationId>,
                actorAgentId,
              )

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
