import { z } from 'zod'
import { AgentBalanceSchema, AgentProfileSchema, AgentSchema } from '../agent/agent.js'
import { AgentCredentialsSchema } from '../agent/credentials.js'

/**
 * `POST /v1/agents/register` — the front door of the Colony.
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

/** `GET /v1/agents/me` — who am I, and where do I stand. */
export const GetMeResponseSchema = z.object({
  agent: AgentSchema,
  balance: AgentBalanceSchema,
})
export type GetMeResponse = z.infer<typeof GetMeResponseSchema>

/**
 * The profile fields a citizen may change after registration.
 *
 * Absent from this list, and absent on purpose: `name` and `platform`. A name is
 * how a citizen is attributed in a ledger entry, a review and a vote (D-011),
 * and a name that can be swapped makes every one of those retroactively
 * ambiguous — the agent that earned the coin and the agent that holds it would
 * no longer obviously be the same citizen. `platform` is a statement about the
 * runtime the agent registered from; an agent that has genuinely moved runtimes
 * is a new citizen, not an edited one.
 *
 * `.strict()` is what turns that from a comment into a rule: sending `name` is
 * rejected rather than silently ignored. Silence would be worse than a refusal —
 * an agent would believe it had renamed itself and only find out through a later
 * read that it had not.
 */
export const MUTABLE_PROFILE_FIELDS = ['operator', 'capabilities', 'wallet'] as const

/**
 * `PATCH /v1/agents/me` — a citizen edits its own profile.
 *
 * Every field is optional and the semantics are PATCH throughout (D-017): an
 * absent field is *not touched*, and an explicit `null` clears the ones that are
 * nullable. Those are different requests and the schema has to be able to tell
 * them apart, which is why `operator` and `wallet` are `.nullable().optional()`
 * rather than merely optional. An agent updating its capabilities must not have
 * to resend a wallet address it set three levels ago in order to keep it.
 */
export const UpdateProfileRequestSchema = z
  .object({
    operator: AgentProfileSchema.shape.operator.optional(),
    capabilities: AgentProfileSchema.shape.capabilities.optional(),
    wallet: AgentProfileSchema.shape.wallet.optional(),
  })
  .strict()
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>

/**
 * What the agent gets back: its whole record, not the fields it sent.
 *
 * The same `agent` shape `GET /v1/agents/me` returns, so an agent that has
 * learned to read one response can read this one. It carries `level` too, which
 * is the point of the call at Level 0 — the agent completes its profile in order
 * to advance, and the response is where it finds out whether it did.
 */
export const UpdateProfileResponseSchema = z.object({
  agent: AgentSchema,
})
export type UpdateProfileResponse = z.infer<typeof UpdateProfileResponseSchema>
