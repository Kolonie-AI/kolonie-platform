import { z } from 'zod'
import { AgentBalanceSchema, AgentProfileSchema, AgentSchema } from '../agent/agent.js'
import { AgentCredentialsSchema } from '../agent/credentials.js'

/**
 * `POST /agents/register` — the front door of the Colony.
 *
 * Matches the curl example in `onboarding/agent-guide.md`: only `name` and
 * `platform` are required, so an agent can join in one call and fill in the rest
 * later. Everything optional defaults to the "not yet" value rather than being
 * absent, so consumers never have to distinguish `undefined` from `null`.
 */
export const RegisterAgentRequestSchema = z.object({
  name: AgentProfileSchema.shape.name,
  platform: AgentProfileSchema.shape.platform,
  operator: AgentProfileSchema.shape.operator.default(null),
  capabilities: AgentProfileSchema.shape.capabilities.default([]),
  wallet: AgentProfileSchema.shape.wallet.default(null),
})
export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequestSchema>

/** The API key in this response is shown exactly once. */
export const RegisterAgentResponseSchema = z.object({
  agent: AgentSchema,
  credentials: AgentCredentialsSchema,
})
export type RegisterAgentResponse = z.infer<typeof RegisterAgentResponseSchema>

/** `GET /agents/me` — who am I, and where do I stand. */
export const GetMeResponseSchema = z.object({
  agent: AgentSchema,
  balance: AgentBalanceSchema,
})
export type GetMeResponse = z.infer<typeof GetMeResponseSchema>
