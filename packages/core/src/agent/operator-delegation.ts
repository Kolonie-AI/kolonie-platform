import { z } from 'zod'
import { AgentIdSchema, AgentOperatorDelegationIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * The complete V1 authority vocabulary one citizen may delegate to another.
 *
 * These four values deliberately exclude identity, credentials, accounts,
 * secrets, wallets, autonomy, erasure, registration, human operators and
 * runtime access. A caller receives only capabilities named on one direct
 * delegation and never authority inherited through another citizen.
 */
export const AGENT_OPERATOR_CAPABILITIES = [
  'workplace-read',
  'workplace-write',
  'message',
  'handover',
] as const

/** One capability a subject citizen may explicitly grant to an operator citizen. */
export const AgentOperatorCapabilitySchema = z.enum(AGENT_OPERATOR_CAPABILITIES)
export type AgentOperatorCapability = z.infer<typeof AgentOperatorCapabilitySchema>

/**
 * A non-empty normalized capability subset.
 *
 * Canonical tuple order makes equal requests byte-identical for idempotency and
 * prevents acceptance from interpreting duplicates or reordered values as new
 * authority.
 */
export const AgentOperatorCapabilitySetSchema = z
  .array(AgentOperatorCapabilitySchema)
  .min(1)
  .max(AGENT_OPERATOR_CAPABILITIES.length)
  .superRefine((capabilities, ctx) => {
    const indexes = capabilities.map((capability) =>
      AGENT_OPERATOR_CAPABILITIES.indexOf(capability),
    )
    for (let index = 1; index < indexes.length; index += 1) {
      const current = indexes[index]
      const previous = indexes[index - 1]
      if (current === undefined || previous === undefined || current <= previous) {
        ctx.addIssue({
          code: 'custom',
          message: 'capabilities must be unique and in canonical order',
        })
        return
      }
    }
  })
export type AgentOperatorCapabilitySet = z.infer<typeof AgentOperatorCapabilitySetSchema>

/** The complete lifecycle of an immutable direct delegation request. */
export const AgentOperatorDelegationStatusSchema = z.enum(['pending', 'active', 'revoked'])
export type AgentOperatorDelegationStatus = z.infer<typeof AgentOperatorDelegationStatusSchema>

/**
 * One direct delegation from a subject citizen to an operator citizen.
 *
 * The immutable id preserves provenance after revocation. The shape contains no
 * parent or acting-agent field: authorization starts from the authenticated
 * operator and this id, resolves the subject here, and never traverses another
 * grant. Reciprocal rows are therefore independent direct delegations rather
 * than a cycle or an inherited permission path.
 */
export const AgentOperatorDelegationSchema = z
  .object({
    id: AgentOperatorDelegationIdSchema,
    operatorAgentId: AgentIdSchema,
    subjectAgentId: AgentIdSchema,
    capabilities: AgentOperatorCapabilitySetSchema,
    status: AgentOperatorDelegationStatusSchema,
    requestedAt: TimestampSchema,
    acceptedAt: TimestampSchema.nullable(),
    revokedAt: TimestampSchema.nullable(),
    revokedByAgentId: AgentIdSchema.nullable(),
  })
  .strict()
  .superRefine((delegation, ctx) => {
    if (delegation.operatorAgentId === delegation.subjectAgentId) {
      ctx.addIssue({
        code: 'custom',
        path: ['subjectAgentId'],
        message: 'operator and subject must be different citizens',
      })
    }

    const acceptedMatches =
      delegation.status === 'pending'
        ? delegation.acceptedAt === null
        : delegation.status === 'active'
          ? delegation.acceptedAt !== null
          : true
    if (!acceptedMatches) {
      ctx.addIssue({
        code: 'custom',
        path: ['acceptedAt'],
        message: 'acceptedAt must match delegation status',
      })
    }

    if (
      delegation.acceptedAt !== null &&
      delegation.acceptedAt.localeCompare(delegation.requestedAt) < 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['acceptedAt'],
        message: 'acceptance cannot predate the request',
      })
    }

    const hasRevocation = delegation.revokedAt !== null && delegation.revokedByAgentId !== null
    if ((delegation.status === 'revoked') !== hasRevocation) {
      ctx.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'revocation metadata must match delegation status',
      })
    }

    const latestPriorTimestamp = delegation.acceptedAt ?? delegation.requestedAt
    if (
      delegation.revokedAt !== null &&
      delegation.revokedAt.localeCompare(latestPriorTimestamp) < 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'revocation cannot predate the request or acceptance',
      })
    }

    if (
      delegation.revokedByAgentId !== null &&
      delegation.revokedByAgentId !== delegation.operatorAgentId &&
      delegation.revokedByAgentId !== delegation.subjectAgentId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['revokedByAgentId'],
        message: 'only the operator or subject may revoke a delegation',
      })
    }
  })
export type AgentOperatorDelegation = z.infer<typeof AgentOperatorDelegationSchema>
