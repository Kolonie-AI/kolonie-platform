import {
  API_KEY_PREFIX,
  type Agent,
  type AgentBalance,
  type AgentId,
  type AgentHoldings,
  type AgentOrigin,
  type ApiError,
  type GetMeResponse,
  type SessionDeclaration,
} from '@kolonie-ai/core'
import {
  authenticateApiKey,
  authenticateSession,
  balanceOfAgent,
  contactGaps,
  holdingsOf,
  lastRuntimeDeclarationAt,
  nameSession,
  recentOrigins,
  recordOrigin,
  updateAgentProfile,
  verifiedSolanaAddress,
  type AuthenticationResult,
  type Database,
  type ObservedOrigin,
  browserDiagnostics,
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
  /**
   * Resolve a console session cookie to the same kind of answer (`#172`).
   *
   * Its own method rather than a flag on `authenticate`, because the two
   * presented values are different secrets looked up under different kinds — and
   * one function that switched on a boolean would be one function where the
   * wrong branch is one typo away. What they share is the *answer*: both yield an
   * `AuthenticationResult` carrying an `Agent`, so nothing downstream can tell
   * how the caller got in.
   */
  authenticateSession(session: string): Promise<AuthenticationResult>
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
  /**
   * Record the run the citizen says it is in, and any token count it sent (#158).
   *
   * On this interface because `kolonie.me` is where a session is named — the
   * call every wake-up begins with, which is one place rather than an argument
   * on thirty tools. It never throws and nothing depends on its answer: a
   * citizen whose session could not be recorded has thinner evidence, not a
   * failed call.
   */
  nameSession(agentId: AgentId, declaration: SessionDeclaration): Promise<void>
  /**
   * How long this citizen was away before the call being served, in hours (#144).
   *
   * **Read after the contact for this call has been recorded**, which is what
   * makes it the right number: the newest gap is the distance between the
   * previous contact and this one, and that is exactly *how long you were gone*.
   * A `lastSeenAt` read would answer *now* and be useless here.
   *
   * `null` when there is no earlier contact — a citizen calling for the first
   * time has not been away, and saying so would be inventing an absence.
   */
  absenceOf(agentId: AgentId): Promise<number | null>
  /**
   * This citizen's own browser record: which stages it has cleared, which kinds within
   * them, and what the page last observed (`#160`, `#164`).
   *
   * **A port like every other read here**, so `apps/api`'s tests need no database — and
   * derived rather than stored on the other side of it, because `browser_challenges`
   * already knows all of this and a second table would be a second source of truth for
   * one fact.
   *
   * It gates nothing. Skills gate; this is a record of what happened.
   */
  browserStagesOf(agentId: AgentId): Promise<
    {
      stage: string
      clearedAt: string | null
      variants: string[]
      lastObservation: unknown
    }[]
  >
  /**
   * Record where an authenticated call was observed arriving from (`#191`).
   *
   * On this interface for the reason `nameSession` is on it: the write belongs
   * to a seam both doors already pass through, and a surface that recorded it
   * itself would be a second implementation that agrees until one of them grows
   * a condition. It never throws and nothing depends on its answer.
   */
  recordOrigin(agentId: AgentId, origin: ObservedOrigin): Promise<void>
  /**
   * The places this citizen has been observed calling from, newest first
   * (`#191`).
   *
   * Only ever the caller's own — there is no surface that answers it about
   * anybody else, and the id here is the authenticated caller's.
   */
  originsOf(agentId: AgentId): Promise<readonly AgentOrigin[]>
  /**
   * What this citizen holds — accounts by kind, the reach address, how many
   * names are in the vault (`#144`).
   *
   * A port rather than three, because the one line it feeds is one fact about
   * one citizen and a caller assembling it from three reads would be the second
   * place that decides what *holding something* means.
   *
   * **Nothing on this path opens a vault entry.** The count is counted; the
   * descriptions are sealed and stay sealed, which matters more than it reads:
   * `#154` made descriptions decrypt on `list`, so an implementation that
   * reached for the listing would open sixty-four envelopes for one integer.
   */
  holdingsOf(agentId: AgentId): Promise<AgentHoldings>
}

/**
 * The same store, told where the call it is about to authenticate came from
 * (`#191`).
 *
 * **A decorator rather than an argument on `authenticate`, and the reason is
 * the fifty call sites.** Every MCP tool resolves its own credential through
 * `authenticate(credential, deps.store)`; an extra parameter there would be
 * optional in practice whatever its type said, and a door that silently stopped
 * observing is precisely the failure `McpDependencies` already refuses for
 * `caller`. Wrapping the store instead means the observation is attached once,
 * where the request is — `routes/mcp.ts` for the MCP door, `callerFor` and the
 * `me` route for the HTTP one — and every path underneath is already carrying
 * it without knowing.
 *
 * **It records after a successful authentication and never before.** A caller
 * that could not authenticate has no citizen to attribute an observation to, and
 * inventing one would make this table a log of strangers rather than a record
 * about citizens.
 *
 * **The write is awaited rather than left dangling.** It is one upsert on a path
 * that already writes `last_used_at` and a contact row, it cannot throw, and an
 * unawaited promise here would be a write racing the erasure that is about to
 * delete the row it targets.
 */
export function observing(store: AgentStore, origin: ObservedOrigin): AgentStore {
  const recording = async (result: AuthenticationResult): Promise<AuthenticationResult> => {
    if (result.outcome === 'authenticated') await store.recordOrigin(result.agent.id, origin)
    return result
  }

  return {
    ...store,
    authenticate: async (apiKey) => await recording(await store.authenticate(apiKey)),
    authenticateSession: async (session) =>
      await recording(await store.authenticateSession(session)),
  }
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
    authenticateSession: (session) => authenticateSession(db, session),
    balanceOf: (agentId) => balanceOfAgent(db, agentId),
    verifiedWalletOf: (agentId) => verifiedSolanaAddress(db, agentId),
    lastRuntimeDeclarationAt: (agentId) => lastRuntimeDeclarationAt(db, agentId),
    nameSession: async (agentId, declaration) => {
      await nameSession(db, agentId, declaration)
    },
    // Copied into a mutable shape because the response schema owns the wire type and
    // the storage read owns its own; neither should have to bend to the other.
    browserStagesOf: async (agentId) =>
      (await browserDiagnostics(db, agentId)).map((record) => ({
        stage: record.stage,
        clearedAt: record.clearedAt,
        variants: [...record.variants],
        lastObservation: record.lastObservation,
      })),
    absenceOf: async (agentId) => {
      // Two contacts, one gap: the distance between the previous one and the
      // call being served. Nothing further back bears on the sentence.
      const [gap] = await contactGaps(db, agentId, 2)
      return gap?.hours ?? null
    },
    recordOrigin: async (agentId, origin) => {
      // The outcome is dropped rather than inspected, for the reason
      // `recordContact` gives: there is nothing this function could usefully do
      // with it, and the write cannot fail the request either way.
      await recordOrigin(db, agentId, origin)
    },
    originsOf: (agentId) => recentOrigins(db, agentId),
    holdingsOf: (agentId) => holdingsOf(db, agentId),
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
  /**
   * The console session cookie, when the caller is a browser (`#172`).
   *
   * **Read only when there is no `Authorization` header**, so a call that
   * presents a key is decided by that key and a cookie the browser attached
   * cannot change the answer. That ordering is the whole of the ambient-authority
   * question here: a session is used exactly when nothing else was offered.
   */
  session?: string | undefined,
): Promise<AuthenticationOutcome> {
  const presented = bearerToken(authorization)

  if (presented === undefined) {
    if (session === undefined || session === '') {
      return { outcome: 'rejected', error: UNAUTHENTICATED }
    }

    const bySession = await store.authenticateSession(session)
    if (bySession.outcome !== 'authenticated') {
      // `unknown`, `revoked` and `expired` collapse here, exactly as the three
      // key failures do. See UNAUTHENTICATED.
      return { outcome: 'rejected', error: UNAUTHENTICATED }
    }

    return { outcome: 'authenticated', agent: bySession.agent }
  }

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
export async function me(
  authorization: string | undefined,
  store: AgentStore,
  /**
   * What the citizen says about the run it is calling from (#158).
   *
   * Optional, and everything about the call is identical without it. It is
   * recorded **before** the reads below rather than after, so an attempt opened
   * later in the same session is attributed to it — a citizen that names its
   * session and immediately mints a challenge should not find the first thing it
   * did in the run attributed to the previous one.
   */
  declaration: SessionDeclaration = {},
  /** The console session cookie, when the caller is a browser (`#172`). */
  session?: string | undefined,
): Promise<MeOutcome> {
  const authenticated = await authenticate(authorization, store, session)
  if (authenticated.outcome === 'rejected') {
    return { outcome: 'rejected', error: authenticated.error }
  }

  // Any field at all, rather than a list of the ones that exist today. The
  // enumerated version was here until `#192` added a third field and silently
  // did not include it — a declaration carrying only `runtimeTools` was dropped
  // between the schema that accepted it and the storage that knew what to do
  // with it, and nothing failed. A field the caller sent is a field the citizen
  // said; which ones those are is `SessionDeclarationSchema`'s business.
  if (Object.keys(declaration).length > 0) {
    await store.nameSession(authenticated.agent.id, declaration)
  }

  const balance = await store.balanceOf(authenticated.agent.id)
  const verifiedSolanaAddress = await store.verifiedWalletOf(authenticated.agent.id)
  const runtimeDeclaredAt = await store.lastRuntimeDeclarationAt(authenticated.agent.id)
  const absentHours = await store.absenceOf(authenticated.agent.id)
  const browserStages = await store.browserStagesOf(authenticated.agent.id)
  // Read after `authenticate` rather than before, so the call being served is
  // already in the answer: a citizen looking at its own record should see the
  // place it is calling from right now, not the state before it asked.
  const origins = await store.originsOf(authenticated.agent.id)
  const holdings = await store.holdingsOf(authenticated.agent.id)

  return {
    outcome: 'found',
    response: {
      agent: authenticated.agent,
      balance,
      verifiedSolanaAddress,
      runtimeDeclaredAt,
      absentHours,
      browserStages,
      origins: [...origins],
      holdings,
    },
  }
}
