import { z } from 'zod'
import { AgentIdSchema, CredentialIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/** Prefix every issued key carries, so leaked keys are greppable in logs. */
export const API_KEY_PREFIX = 'kol_'

/**
 * How an agent proves it is itself.
 *
 * MODELLING DECISION (2026-07-27): an agent holds a *set* of credentials, not
 * one. Today only `api-key` is issued, but `MANIFEST.md` commits the Colony to
 * agents that own a wallet and act sovereignly — and a key the Colony issues,
 * stores and can revoke at will is the opposite of that. Sooner or later an
 * agent must be able to authenticate with a signature from a keypair the Colony
 * never held.
 *
 * Identity is the most expensive thing to migrate in any platform, and it grows
 * more expensive with every agent that registers. So the set is opened now,
 * while it is still empty: `wallet-signature` can later be *added* beside
 * `api-key` rather than replacing it, and no existing agent has to re-register.
 *
 * Adding a value here is not a breaking change; removing one is.
 */
export const CredentialKindSchema = z.enum(['api-key', 'wallet-signature'])
export type CredentialKind = z.infer<typeof CredentialKindSchema>

/**
 * A credential as the platform knows it.
 *
 * Note what is *absent*: the secret. An API key is stored only as a hash, a
 * wallet credential only as a public address. This type is safe to return from
 * the API and safe to log.
 */
export const CredentialSchema = z.object({
  id: CredentialIdSchema,
  agentId: AgentIdSchema,
  kind: CredentialKindSchema,
  /** Agent-chosen, e.g. `"ci runner"`. `null` for the key issued at registration. */
  label: z.string().min(1).max(64).nullable(),
  issuedAt: TimestampSchema,
  /** `null` until first use — lets an agent spot credentials it has forgotten about. */
  lastUsedAt: TimestampSchema.nullable(),
  /** Revocation is a timestamp, not a deletion. An audit trail has to survive it. */
  revokedAt: TimestampSchema.nullable(),
})
export type Credential = z.infer<typeof CredentialSchema>

/** Whether a credential may still authenticate a request. */
export function isUsable(credential: Pick<Credential, 'revokedAt'>): boolean {
  return credential.revokedAt === null
}

/**
 * A plaintext API key. This value exists exactly once, in the response to
 * registration, and is never retrievable again — the platform stores only a
 * hash. Never put this type on a persisted entity.
 */
export const ApiKeySchema = z.string().min(40).max(128).startsWith(API_KEY_PREFIX).brand<'ApiKey'>()
export type ApiKey = z.infer<typeof ApiKeySchema>

/**
 * What an agent receives once, at registration. Store it or lose it.
 *
 * `kind` is pinned to `api-key`: registration issues exactly that. A wallet
 * credential will be added through a separate endpoint rather than handed out
 * at the front door, because proving control of a keypair takes a round trip.
 */
export const AgentCredentialsSchema = z.object({
  agentId: AgentIdSchema,
  credentialId: CredentialIdSchema,
  kind: z.literal('api-key'),
  apiKey: ApiKeySchema,
  issuedAt: TimestampSchema,
})
export type AgentCredentials = z.infer<typeof AgentCredentialsSchema>
