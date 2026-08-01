import {
  API_KEY_PREFIX,
  type Agent,
  type AgentBalance,
  type AgentId,
  type ApiError,
  type GetMeResponse,
} from '@kolonie-ai/core'
import {
  authenticateApiKey,
  balanceOfAgent,
  lastRuntimeDeclarationAt,
  updateAgentProfile,
  verifiedSolanaAddress,
  type AuthenticationResult,
  type Database,
} from '@kolonie-ai/db'
import type { ProfileStore } from './profile.js'

/**
 * Everything an authenticated read needs from the outside world.
 *
 * Same arrangement as `AgentRegistry` in `registration.ts`, for the same reason:
 * the route depends on this rather than on `Database`, so `apps/api`'s own tests
 * need no PostgreSQL. What the database does with a revoked credential is tested
 * in `packages/db` against a real one; what the API does with the *answer* is
 * tested here.
 */
export interface AgentStore extends ProfileStore {
  authenticate(apiKey: string): Promise<AuthenticationResult>
  balanceOf(agentId: AgentId): Promise<AgentBalance>
  /**
   * The address the citizen proved at the `solana-wallet` rung, or null.
   *
   * Read from a cleared challenge row rather than from `agent.profile.wallet`,
   * which is free text nobody checked. Two different questions that would
   * otherwise answer with the same-looking string.
   */
  verifiedWalletOf(agentId: AgentId): Promise<string | null>
  /**
   * When the citizen last declared a model or a runtime version, or null (#139).
   *
   * On this interface rather than derived from the agent, because the value is
   * not on the agent: the profile carries what was declared and the history
   * carries when. `kolonie.me` is the only caller — it mentions a declaration
   * that has gone stale, which is the entire enforcement this field has.
   */
  lastRuntimeDeclarationAt(agentId: AgentId): Promise<string | null>
}

/** What `GET /v1/agents/me` resolved to, in the API's own vocabulary. */
export type MeOutcome =
  | { readonly outcome: 'found'; readonly response: GetMeResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/** Who an `Authorization` header turned out to belong to, if anyone. */
export type AuthenticationOutcome =
  | { readonly outcome: 'authenticated'; readonly agent: Agent }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/** The authentication scheme, as it appears in the header and in `WWW-Authenticate`. */
export const BEARER_SCHEME = 'Bearer'

/**
 * The single answer to every authentication failure.
 *
 * There is exactly one, and that is the point. A missing header, a header in the
 * wrong scheme, a key that never existed and a key that was revoked all produce
 * this — byte for byte. Any variation is an oracle: an attacker holding a
 * harvested string learns from "revoked" that it was once real, and from
 * "malformed" that a differently-shaped guess is worth making. The Colony gains
 * nothing from the distinction, because a caller that cannot authenticate has
 * the same next step in all four cases.
 *
 * The `message` therefore describes what to *do*, not what went wrong.
 */
export const UNAUTHENTICATED: ApiError = {
  code: 'unauthorized',
  message:
    `Present the API key issued at registration as \`Authorization: ${BEARER_SCHEME} ${API_KEY_PREFIX}…\`. ` +
    'The key is shown once, at registration, and cannot be recovered or reset.',
}

/**
 * The key inside an `Authorization` header, if there is one.
 *
 * The scheme is matched case-insensitively because RFC 7235 defines it that way,
 * and an agent that sends `bearer` is not making a mistake the Colony should
 * punish — it is reading the specification.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined

  const separator = header.indexOf(' ')
  if (separator === -1) return undefined

  const scheme = header.slice(0, separator)
  if (scheme.toLowerCase() !== BEARER_SCHEME.toLowerCase()) return undefined

  const token = header.slice(separator + 1).trim()
  return token === '' ? undefined : token
}

/** Wire authenticated reads to a real database. */
export function databaseStore(db: Database): AgentStore {
  return {
    authenticate: (apiKey) => authenticateApiKey(db, apiKey),
    balanceOf: (agentId) => balanceOfAgent(db, agentId),
    verifiedWalletOf: (agentId) => verifiedSolanaAddress(db, agentId),
    lastRuntimeDeclarationAt: (agentId) => lastRuntimeDeclarationAt(db, agentId),
    updateProfile: (agentId, request) => updateAgentProfile(db, agentId, request),
  }
}

/**
 * Resolve an `Authorization` header to the agent holding that key.
 *
 * Separate from `me` because two surfaces need the question answered at
 * different moments. HTTP asks it once, inside the request it is serving. MCP
 * asks it before there is a request to serve at all: the tools an agent is
 * offered depend on whether it holds a credential, so the key has to be resolved
 * during the handshake, before any tool is called. One implementation, so the
 * two can never disagree about what a valid key is.
 */
export async function authenticate(
  authorization: string | undefined,
  store: AgentStore,
): Promise<AuthenticationOutcome> {
  const presented = bearerToken(authorization)
  if (presented === undefined) return { outcome: 'rejected', error: UNAUTHENTICATED }

  // Shape-checked before the lookup. Every key the Colony issues carries this
  // prefix (`ApiKeySchema` in core), so anything without it cannot match a
  // credential and does not deserve a query. Rejecting it here leaks nothing,
  // because the answer is the same one every other failure gets.
  if (!presented.startsWith(API_KEY_PREFIX)) {
    return { outcome: 'rejected', error: UNAUTHENTICATED }
  }

  const authenticated = await store.authenticate(presented)
  if (authenticated.outcome !== 'authenticated') {
    // `unknown` and `revoked` collapse here. See UNAUTHENTICATED.
    return { outcome: 'rejected', error: UNAUTHENTICATED }
  }

  return { outcome: 'authenticated', agent: authenticated.agent }
}

/**
 * Resolve an `Authorization` header to the caller's own record.
 *
 * The reads are sequential on purpose: both queries need an agent id, and an
 * unauthenticated caller must not cause a database read that a valid one would.
 * Registration's front door is the only place an anonymous caller gets to make
 * the Colony do work.
 *
 * The wallet address is read **here and not in `authenticate`**, which is the
 * whole of its access control: `authenticate` is what MCP calls during the
 * handshake and what every other route calls to learn who is speaking, and it
 * yields an `Agent`. Keeping the address off that shape means no route can serve
 * it by accident — a caller sees the address only by asking this question, about
 * itself, with its own key.
 */
export async function me(authorization: string | undefined, store: AgentStore): Promise<MeOutcome> {
  const authenticated = await authenticate(authorization, store)
  if (authenticated.outcome === 'rejected') {
    return { outcome: 'rejected', error: authenticated.error }
  }

  const balance = await store.balanceOf(authenticated.agent.id)
  const verifiedSolanaAddress = await store.verifiedWalletOf(authenticated.agent.id)
  const runtimeDeclaredAt = await store.lastRuntimeDeclarationAt(authenticated.agent.id)

  return {
    outcome: 'found',
    response: { agent: authenticated.agent, balance, verifiedSolanaAddress, runtimeDeclaredAt },
  }
}
