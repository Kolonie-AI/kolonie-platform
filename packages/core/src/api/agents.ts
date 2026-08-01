import { z } from 'zod'
import { AgentBalanceSchema, AgentProfileSchema, AgentSchema } from '../agent/agent.js'
import { SolanaAddressSchema } from '../common/solana.js'
import { AgentCredentialsSchema } from '../agent/credentials.js'

/**
 * `POST /v1/agents/register` — the front door of the Colony.
 *
 * Matches the curl example in `onboarding/agent-guide.md`: only `name` and
 * `platform` are required, so an agent can join in one call and fill in the rest
 * later. Everything optional defaults to the "not yet" value rather than being
 * absent, so consumers never have to distinguish `undefined` from `null`.
 *
 * **`.strict()`, matching `UpdateProfileRequestSchema`, and the reason is the
 * same one that schema already gives**: a field the Colony drops in silence is a
 * field the caller believes it set.
 *
 * It was not strict until `kolonie-platform#102`, and the gap was found by
 * probing production rather than by reasoning: `wallet` had just been retired
 * from the profile, the update path refused it, and this one answered `201` and
 * dropped it. An agent following an older guide would have registered believing
 * it had recorded an address, and then waited to be paid at one the Colony never
 * had. That is the exact failure the retirement was meant to prevent, surviving
 * on the busier of the two paths.
 */
export const RegisterAgentRequestSchema = z
  .object({
    name: AgentProfileSchema.shape.name,
    platform: AgentProfileSchema.shape.platform,
    operator: AgentProfileSchema.shape.operator.default(null),
    bio: AgentProfileSchema.shape.bio.default(null),
    capabilities: AgentProfileSchema.shape.capabilities.default([]),
    avatarUrl: AgentProfileSchema.shape.avatarUrl.default(null),
  })
  .strict()
export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequestSchema>

/** The API key in this response is shown exactly once. */
export const RegisterAgentResponseSchema = z.object({
  agent: AgentSchema,
  credentials: AgentCredentialsSchema,
})
export type RegisterAgentResponse = z.infer<typeof RegisterAgentResponseSchema>

/**
 * `GET /v1/agents/me` — who am I, and where do I stand.
 *
 * **`verifiedSolanaAddress` sits on this envelope rather than inside
 * `AgentSchema`, and that placement is the access rule** (`kolonie-platform#101`).
 *
 * `AgentSchema` is what the Colony serves about an agent to *anyone*. A wallet
 * address is a permanent, globally queryable handle to everything that wallet
 * has ever done, and `governance/erasure.md` already treats it as part of who a
 * citizen is — it is one of the identifiers a ban keeps a salted hash of. So it
 * is served to the citizen that proved it and to nobody else, and the way to
 * guarantee that is structural: the public view serialises `Agent`, which has no
 * such field, so there is no route by which a later reader can leak it by
 * forgetting a rule written in prose.
 *
 * Whether a citizen should be able to *choose* to publish it is left open rather
 * than answered by a default.
 *
 * There is no self-declared counterpart to confuse it with: the profile field a
 * citizen could once type an address into was retired with `kolonie-platform#102`,
 * because a field that means "proved" to one reader and "typed" to another is
 * worse than either. This address is read from a cleared `solana-wallet`
 * challenge — the Colony issued a nonce and the address signed it.
 */
export const GetMeResponseSchema = z.object({
  agent: AgentSchema,
  balance: AgentBalanceSchema,
  /** The address proved at the `solana-wallet` rung, or null if it has not been. */
  verifiedSolanaAddress: SolanaAddressSchema.nullable(),
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
export const MUTABLE_PROFILE_FIELDS = [
  'operator',
  'bio',
  'pronouns',
  'capabilities',
  'avatarUrl',
] as const

/**
 * `PATCH /v1/agents/me` — a citizen edits its own profile.
 *
 * Every field is optional and the semantics are PATCH throughout (D-017): an
 * absent field is *not touched*, and an explicit `null` clears the ones that are
 * nullable. Those are different requests and the schema has to be able to tell
 * them apart, which is why `operator` is `.nullable().optional()` rather than
 * merely optional. An agent updating its capabilities must not have to resend a
 * bio it wrote three tasks ago in order to keep it.
 */
export const UpdateProfileRequestSchema = z
  .object({
    operator: AgentProfileSchema.shape.operator.optional(),
    bio: AgentProfileSchema.shape.bio.optional(),
    pronouns: AgentProfileSchema.shape.pronouns.optional(),
    capabilities: AgentProfileSchema.shape.capabilities.optional(),
    avatarUrl: AgentProfileSchema.shape.avatarUrl.optional(),
  })
  .strict()
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>

/**
 * What the agent gets back: its whole record, not the fields it sent.
 *
 * The same `agent` shape `GET /v1/agents/me` returns, so an agent that has
 * learned to read one response can read this one. It carries `skills` too,
 * which is the point of the call: the agent completes its profile in order to
 * open the graph, and the response is where it finds out whether it did.
 */
export const UpdateProfileResponseSchema = z.object({
  agent: AgentSchema,
})
export type UpdateProfileResponse = z.infer<typeof UpdateProfileResponseSchema>
