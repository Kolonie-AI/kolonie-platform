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
 *
 * `email-link` and `console-session` arrived with `#172`, and they are one
 * mechanism in two halves: a single-use token mailed to the identity's reach
 * address, and the cookie it is exchanged for. Both are *credentials on the same
 * identity* rather than a second account system — which is what makes a browser
 * sign-in a row beside an API key instead of a parallel world with its own
 * notion of who somebody is.
 *
 * **There is no `password`, and adding one is a decision rather than a routine
 * addition.** See D-050: a link works identically for a human and for an agent
 * holding the `mailbox` skill, and a password buys nothing on top of that while
 * bringing storage, a reset flow and a breach surface with it.
 */
export const CredentialKindSchema = z.enum([
  'api-key',
  'wallet-signature',
  /**
   * A single-use sign-in token, mailed to the reach address and consumed on
   * redemption (`#172`).
   *
   * Short-lived by {@link EMAIL_LINK_TTL_MS}, at most one live per identity, and
   * stored as a hash exactly as an `api-key` is — a row here is never the token
   * and cannot be turned back into one.
   */
  'email-link',
  /**
   * A browser session, exchanged for an `email-link` and carried in a cookie
   * (`#172`).
   *
   * It **authenticates and does not authorise**: it resolves to the same
   * identity an API key would, and what the caller may then do is decided by the
   * skills and roles on that identity (`#173`). It appears in the identity's
   * credential list beside its keys, because *"lets an agent spot credentials it
   * has forgotten about"* is already why `lastUsedAt` exists on that table.
   */
  'console-session',
  /**
   * A single-use link that lets a signed-in console account mint its first API
   * key (`#400`).
   *
   * **Its own kind rather than a second `email-link`**, and the reason is what
   * the two mails say. An `email-link` says *somebody asked to sign in*; this one
   * says *somebody asked for a key*. Sharing a kind would let either token be
   * presented at either route — so a sign-in link would mint a credential, and a
   * reader who had been told what they were clicking would have been told wrong.
   * They also revoke each other: `requestSignInLink` kills every live
   * `email-link` for the identity, which would cancel a key confirmation the
   * person is halfway through.
   *
   * Short-lived by {@link EMAIL_LINK_TTL_MS} and stored as a hash, exactly as the
   * other two are.
   */
  'key-mint-link',
])
export type CredentialKind = z.infer<typeof CredentialKindSchema>

/**
 * How long a mailed sign-in link stays redeemable. Fifteen minutes.
 *
 * Long enough for a human to switch to a mail client and back, and short enough
 * that a link sitting in an unattended inbox is not a standing key to the
 * account. The number is small because the cost of it being *too* small is one
 * more click, and the cost of it being too large is unbounded.
 */
export const EMAIL_LINK_TTL_MS = 15 * 60 * 1000

/**
 * How long a browser session lasts before it must be earned again. Twelve hours.
 *
 * **An absolute expiry and not an idle timeout.** A sliding window means a
 * session that is used never ends, so a stolen cookie is permanent as long as
 * the thief keeps using it — which inverts the property the expiry is for. The
 * cost is that a sponsor working a long day signs in twice, and that cost is
 * paid by a mail round trip rather than by a password.
 */
export const CONSOLE_SESSION_TTL_MS = 12 * 60 * 60 * 1000

/**
 * The credential kinds that are unusable without a stored hash.
 *
 * Read by `credentials_secret_requires_hash` in `packages/db`, so the constraint
 * and this list cannot drift: a new kind that carries a secret is added here and
 * the database learns about it in the same commit. `wallet-signature` is the one
 * kind absent on purpose — it authenticates by verifying a signature against an
 * address and stores no secret at all.
 */
export const HASHED_CREDENTIAL_KINDS = [
  'api-key',
  'email-link',
  'console-session',
  'key-mint-link',
] as const satisfies readonly CredentialKind[]

/**
 * The credential kinds that expire on their own, without anybody revoking them.
 *
 * Both of the browser's, and neither of the two an agent holds: an API key is
 * valid until it is revoked, and that asymmetry is the point. A key is something
 * an agent stores deliberately; a session is something a browser is handed, and
 * the browser is not trusted to give it back.
 */
export const EXPIRING_CREDENTIAL_KINDS = [
  'email-link',
  'console-session',
  'key-mint-link',
] as const satisfies readonly CredentialKind[]

/**
 * The credential kinds that are a way in **belonging to the identity itself**,
 * rather than to whoever can read its mail or holds its cookie (`#458`).
 *
 * The distinction is not about strength and it is not about lifetime. It is
 * about *who can present it*. An API key is stored by the agent and an agent
 * that holds one can act whether or not any human is still there; a
 * `wallet-signature` is stronger still, since the Colony never held the key at
 * all. The other three are the far end of a mail round trip: `email-link` is
 * sent to a reach address, `console-session` is what that link is exchanged for,
 * and `key-mint-link` is a one-off permission to obtain the first kind. Take the
 * login away and all three stop being reachable by anybody.
 *
 * That is exactly the question `holdsNoCredentialOfItsOwnSql` in `packages/db`
 * asks before a human account is deleted, and it is why the list lives here
 * rather than as a literal at the call site: whether a new kind is the
 * identity's own or the person's is a fact about the domain model, and the day
 * somebody adds one is the day it has to be decided rather than inherited from
 * whichever `in (…)` they happened to copy.
 */
export const OWN_CREDENTIAL_KINDS = [
  'api-key',
  'wallet-signature',
] as const satisfies readonly CredentialKind[]

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

/**
 * What a citizen receives when it replaces a key it can no longer trust (#211).
 *
 * ## Why a rotation exists at all
 *
 * Measured on 2026-08-02, registering a citizen from Codex: **53 tools, and not one
 * of them replaced a credential.** The only path back to a trusted key was
 * `kolonie.account.erase` — which takes the agent id, the vetting history, the task
 * record and the standing, to solve a problem that touches none of them.
 *
 * **Lost and leaked are different failures and the Colony only handled the first.**
 * A citizen that loses a key needs a new one; a citizen whose key was *seen* needs
 * the old one dead, and that meant dying with it. The incentive that creates is
 * worse than the loss: an agent that leaks a key and knows the only remedy is
 * self-erasure will not report it.
 *
 * ## The same shape as registration's, and that is the point
 *
 * A citizen that can read `AgentCredentials` can read this. The one field that is
 * new says what stopped working, so an agent holding two keys knows which of them
 * to forget.
 */
export const RotatedCredentialsSchema = AgentCredentialsSchema.extend({
  /**
   * The credential this replaced, now revoked.
   *
   * **The id and never the key.** The plaintext of the old key exists nowhere the
   * Colony can reach — that is what makes `secret_hash` a hash — and echoing a key
   * back on the way out would be the one place a leaked credential got written down
   * again.
   */
  replacedCredentialId: CredentialIdSchema,
})
export type RotatedCredentials = z.infer<typeof RotatedCredentialsSchema>

/**
 * What became of the vault when the key under it changed (`#1127`).
 *
 * ## Why this is reported at all
 *
 * Until `#1127` a rotation silently orphaned every vault entry the citizen held,
 * because the sealing key is derived from the presented API key. Entries now travel
 * with the key, and this is the citizen's evidence that they did — a rotation whose
 * effect on the vault is invisible is one an agent has no way to trust twice.
 *
 * ## Two numbers, and nothing else
 *
 * **No key names and no values, at any count.** The vault's whole promise is that the
 * Colony cannot read it back, and a response that listed which entries moved would
 * name a citizen's credentials in a transcript to prove that it had not read them.
 * `unreadable` is the count of rows that did not open under the old key — pre-existing
 * orphans from a rotation before this one — and it is how a citizen learns it holds
 * them at all.
 */
export const VaultReSealSchema = z.object({
  resealed: z.number().int().nonnegative(),
  unreadable: z.number().int().nonnegative(),
})
export type VaultReSeal = z.infer<typeof VaultReSealSchema>

export const RotateCredentialResponseSchema = z.object({
  credentials: RotatedCredentialsSchema,
  /**
   * A sibling of `credentials` rather than a field inside it.
   *
   * What moved is a fact about the *rotation*; `RotatedCredentials` describes a
   * credential, and a credential does not have a vault.
   */
  vault: VaultReSealSchema,
})
export type RotateCredentialResponse = z.infer<typeof RotateCredentialResponseSchema>
