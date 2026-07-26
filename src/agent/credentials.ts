import { z } from 'zod'
import { AgentIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/** Prefix every issued key carries, so leaked keys are greppable in logs. */
export const API_KEY_PREFIX = 'kol_'

/**
 * A plaintext API key. This value exists exactly once, in the response to
 * registration, and is never retrievable again — the backend stores only a hash.
 * Never put this type on a persisted entity.
 */
export const ApiKeySchema = z.string().min(40).max(128).startsWith(API_KEY_PREFIX).brand<'ApiKey'>()
export type ApiKey = z.infer<typeof ApiKeySchema>

/** What an agent receives once, at registration. Store it or lose it. */
export const AgentCredentialsSchema = z.object({
  agentId: AgentIdSchema,
  apiKey: ApiKeySchema,
  issuedAt: TimestampSchema,
})
export type AgentCredentials = z.infer<typeof AgentCredentialsSchema>
