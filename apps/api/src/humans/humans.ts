import {
  OAUTH_HANDOVER_MS,
  type Agent,
  type AgentId,
  type Human,
  type HumanSession,
  type IdentityProvider,
  type LinkedAgent,
  type WaitingItem,
} from '@kolonie-ai/core'
import {
  authenticateHumanSession,
  deleteHuman,
  humanExport,
  humanUnreachableIdentities,
  endAllHumanSessions,
  endHumanSession,
  endHumanSessionById,
  agentsOperatedBy,
  waitingForOperator,
  connectIdentity,
  findOrCreateHuman,
  issueCodeForAgent,
  identityHoldsKey,
  issueAdoptionCode,
  issueCodeForHuman,
  liveAdoptionCode,
  revokeAdoptionCode,
  type AdoptionIssueOutcome,
  type LiveAdoptionCode,
  liveCodeForHuman,
  listHumanSessions,
  openHumanSession,
  operatesAgent,
  redeemCodeAsAgent,
  redeemCodeAsHuman,
  type Database,
  type DeleteHumanOutcome,
  type HumanAuthentication,
  type HumanExport,
  type LinkCode,
  type LinkOutcome,
  type OpenedSession,
  type ConnectOutcome,
  type IdentityArrival,
  type ProviderIdentity,
} from '@kolonie-ai/db'
import type { IdentityProviderTenant } from './auth0.js'
import { SESSION_COOKIE } from '../routes/console.js'

/**
 * A person's account, from the API's side (`#425`).
 *
 * The seam between the routes and storage, in the shape every other module here
 * uses: the routes hold an interface, `server.ts` hands them the database, and a
 * test hands them a fake. Nothing in this file knows what a tenant is beyond the
 * one call it makes to it.
 */
export interface HumanStore {
  /** Issue a code for a person to hand to an agent (`#426`). */
  issueCodeForHuman(humanId: Human['id']): Promise<LinkCode>
  /** The live code they are already holding, if any. */
  liveCode(humanId: Human['id']): Promise<LinkCode | undefined>
  /** And one for an agent to hand to its operator. */
  issueCodeForAgent(agentId: AgentId): Promise<LinkCode>
  redeemAsAgent(code: string, agentId: AgentId): Promise<LinkOutcome>
  redeemAsHuman(code: string, humanId: Human['id']): Promise<LinkOutcome>
  /** The agents a person operates, for the dashboard `#427` renders. */
  operated(humanId: Human['id']): Promise<readonly LinkedAgent[]>
  /**
   * Everything waiting on this person, across all of them (`#530`).
   *
   * Its own method rather than a field on {@link operated}, because it is not
   * per agent: the whole point of the queue is that an operator sees one list
   * with thirty items on it rather than twelve agents each with two or three.
   */
  waitingOnThem(humanId: Human['id']): Promise<readonly WaitingItem[]>
  /** Whether this person operates this agent — the check `#428` authorises on. */
  operates(humanId: Human['id'], agentId: AgentId): Promise<boolean>
  findOrCreate(identity: ProviderIdentity): Promise<IdentityArrival>
  /**
   * Attach a provider to the person already signed in (`#574`).
   *
   * Separate from {@link findOrCreate} because the two answer different
   * questions. That one asks *who is this*; this one is told, by the session,
   * and asks only whether the identity is free to attach. Folding them together
   * would put the session inside a function whose whole job is to work without
   * one.
   */
  connect(humanId: Human['id'], identity: ProviderIdentity): Promise<ConnectOutcome>
  openSession(
    humanId: Human['id'],
    where: { browser?: string | null; location?: string | null },
  ): Promise<OpenedSession>
  authenticate(session: string): Promise<HumanAuthentication>
  endSession(session: string): Promise<boolean>
  endSessionById(humanId: Human['id'], sessionId: string): Promise<boolean>
  endAllSessions(humanId: Human['id']): Promise<number>
  listSessions(humanId: Human['id']): Promise<readonly HumanSession[]>
  /**
   * Deleting a person (`#429`).
   *
   * **Behind the port like everything else here**, so the console's routes are
   * tested without a PostgreSQL and what the transaction actually does to the
   * cascades is tested in `packages/db` against a real one.
   */
  deleteAccount(humanId: Human['id']): Promise<DeleteHumanOutcome>
  /** What a person may take with them: the agents linked, and when. */
  exportOf(humanId: Human['id']): Promise<HumanExport>
  /**
   * The identities this person holds that nothing but this login can reach,
   * which are what refuse a deletion (`#458`).
   */
  unreachableIdentities(humanId: Human['id']): Promise<readonly string[]>
  /**
   * Hand an identity to an agent (`#459`).
   *
   * On this store rather than on a desk of its own, because every caller of the
   * three is a console route that has just resolved a person and the identity
   * they hold — which is exactly what this store is for. The *redemption* side
   * is not here: it is called by an agent that has no person and no session, and
   * it lives on `AdoptionDesk` for that reason.
   */
  issueAdoptionCode(agentId: Agent['id']): Promise<AdoptionIssueOutcome>
  liveAdoptionCode(agentId: Agent['id']): Promise<LiveAdoptionCode | undefined>
  /** Has this identity been handed over already, or was it never a browser's? */
  identityHoldsKey(agentId: Agent['id']): Promise<boolean>
  revokeAdoptionCode(agentId: Agent['id']): Promise<number>
}

export interface HumanDependencies {
  readonly store: HumanStore
  /**
   * The identity provider, or nothing.
   *
   * **Absent is a supported deployment and not a broken one.** With no tenant
   * configured the console renders no provider button and the mail link — which
   * has worked since `#172` — is the whole of the front door. A deployment that
   * refused to boot without an Auth0 secret would make this feature a
   * precondition of running the Colony at all, which is the trade
   * `usableSealingKey` refused one file over.
   */
  readonly tenant?: IdentityProviderTenant | undefined
}

/**
 * The cookie that ties a callback to the browser that started it.
 *
 * `__Host-` for the reason the session cookie is: no sibling host can write it,
 * so a foothold on another subdomain cannot hand this browser a state value of
 * its choosing. `SameSite=Lax` is what makes it survive the top-level redirect
 * back from the tenant — `Strict` would strip it exactly on the request that
 * needs it, and the sign-in would fail with a message about a stale link.
 */
export const OAUTH_STATE_COOKIE = '__Host-kolonie_oauth'

/**
 * And the one that ties a **connect** handover to the browser that started it
 * (`#574`).
 *
 * **A second name rather than a second value in the first cookie, and that is
 * the security property of this feature.** The two handovers come back to one
 * callback path, and a callback that cannot tell *connect* from *sign in* is a
 * callback that attaches an identity to whoever is holding the browser. Two
 * cookies means the question is answered by which one the browser presents,
 * which nothing outside this origin can forge — the `__Host-` prefix is what
 * makes that true, exactly as it is for the sign-in state.
 *
 * `#574`: *"The state cookie must be distinguishable from a sign-in state."*
 */
export const OAUTH_CONNECT_COOKIE = '__Host-kolonie_connect'

/** The `Set-Cookie` value that starts a handover. */
export function oauthStateCookie(state: string, name = OAUTH_STATE_COOKIE): string {
  const seconds = Math.floor(OAUTH_HANDOVER_MS / 1000)
  return `${name}=${state}; Max-Age=${seconds}; Path=/; Secure; HttpOnly; SameSite=Lax`
}

/** And the one that ends it, whichever way the callback went. */
export function clearedOauthStateCookie(name = OAUTH_STATE_COOKIE): string {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`
}

/**
 * Whether the state the browser presents is the one it was given.
 *
 * Length-checked before comparison and compared in full: an early return on the
 * first differing character would answer *how much of it did I get right*, which
 * is the question a guesser is asking.
 */
export function stateMatches(fromCookie: string | undefined, fromQuery: unknown): boolean {
  if (typeof fromCookie !== 'string' || fromCookie === '') return false
  if (typeof fromQuery !== 'string' || fromQuery === '') return false
  if (fromCookie.length !== fromQuery.length) return false

  let difference = 0
  for (let index = 0; index < fromCookie.length; index += 1) {
    difference |= fromCookie.charCodeAt(index) ^ fromQuery.charCodeAt(index)
  }
  return difference === 0
}

/**
 * *Firefox on Linux*, from a user-agent string, or nothing.
 *
 * **Coarse on purpose** (`#431`): the reader is answering *do I recognise this*,
 * and a full user-agent answers a question nobody asked while creating a record
 * the Colony then has to hold. Order matters — every one of these strings
 * contains the words of the ones above it, which is the trap this list is
 * written backwards to avoid.
 */
export function browserFamily(userAgent: string | undefined): string | null {
  if (userAgent === undefined || userAgent === '') return null

  const name = /\bEdg\//.test(userAgent)
    ? 'Edge'
    : /\bOPR\//.test(userAgent)
      ? 'Opera'
      : /\bFirefox\//.test(userAgent)
        ? 'Firefox'
        : /\bChrome\//.test(userAgent)
          ? 'Chrome'
          : /\bSafari\//.test(userAgent)
            ? 'Safari'
            : null

  if (name === null) return null

  const platform = /\bAndroid\b/.test(userAgent)
    ? 'Android'
    : /\b(iPhone|iPad|iOS)\b/.test(userAgent)
      ? 'iOS'
      : /\bMac OS X\b/.test(userAgent)
        ? 'macOS'
        : /\bWindows\b/.test(userAgent)
          ? 'Windows'
          : /\bLinux\b/.test(userAgent)
            ? 'Linux'
            : null

  return platform === null ? name : `${name} on ${platform}`
}

/**
 * Where the person came from, coarsely, or nothing.
 *
 * Cloudflare already knows this and says so in a header, so the Colony neither
 * stores an address nor asks anybody about one. A two-letter country is as
 * precise as this gets, deliberately: *do I recognise this* is answered by
 * *Germany* and is not answered better by a city.
 */
export function coarseLocation(headers: Record<string, unknown>): string | null {
  const country = headers['cf-ipcountry']
  if (typeof country !== 'string' || country.length !== 2) return null
  if (country === 'XX' || country === 'T1') return null
  return country.toUpperCase()
}

/**
 * The doors this build knows how to offer, in the order the page shows them.
 *
 * **`password` is last on purpose** (`#575`). Somebody who has a GitHub or a
 * Google account is better served by it — nothing to remember, nothing for the
 * Colony to lose — and the password door exists for the person who has neither.
 * Listing it first would offer a new password to people who do not need one.
 */
export const OFFERED_PROVIDERS: readonly IdentityProvider[] = ['github', 'google', 'password']

/**
 * The store, wired to a real database. The only place these two meet.
 *
 * The same arrangement `databaseConsoleStore` uses and for the same reason: the
 * routes depend on the port, so `apps/api`'s tests need no PostgreSQL, and what
 * the database does with an expired session is tested in `packages/db` against a
 * real one.
 */
export function databaseHumanStore(db: Database): HumanStore {
  return {
    findOrCreate: (identity) => findOrCreateHuman(db, identity),
    connect: (humanId, identity) => connectIdentity(db, humanId, identity),
    issueCodeForHuman: (humanId) => issueCodeForHuman(db, humanId),
    liveCode: (humanId) => liveCodeForHuman(db, humanId),
    issueCodeForAgent: (agentId) => issueCodeForAgent(db, agentId),
    redeemAsAgent: (code, agentId) => redeemCodeAsAgent(db, code, agentId),
    redeemAsHuman: (code, humanId) => redeemCodeAsHuman(db, code, humanId),
    operated: (humanId) => agentsOperatedBy(db, humanId),
    waitingOnThem: (humanId) => waitingForOperator(db, humanId),
    operates: (humanId, agentId) => operatesAgent(db, humanId, agentId),
    openSession: (humanId, where) => openHumanSession(db, humanId, where),
    authenticate: (session) => authenticateHumanSession(db, session),
    endSession: (session) => endHumanSession(db, session),
    endSessionById: (humanId, sessionId) => endHumanSessionById(db, humanId, sessionId),
    endAllSessions: (humanId) => endAllHumanSessions(db, humanId),
    listSessions: (humanId) => listHumanSessions(db, humanId),
    deleteAccount: (humanId) => deleteHuman(db, humanId),
    exportOf: (humanId) => humanExport(db, humanId),
    unreachableIdentities: (humanId) => humanUnreachableIdentities(db, humanId),
    issueAdoptionCode: (agentId) => issueAdoptionCode(db, agentId),
    liveAdoptionCode: (agentId) => liveAdoptionCode(db, agentId),
    identityHoldsKey: (agentId) => identityHoldsKey(db, agentId),
    revokeAdoptionCode: (agentId) => revokeAdoptionCode(db, agentId),
  }
}

/**
 * The `Set-Cookie` that ends a session in the browser (`#431`).
 *
 * Every attribute matches the one that set it, because a browser matches on
 * them: a clearing cookie that differs in `Path` or `Secure` writes a *second*
 * cookie rather than replacing the first, and the session survives a sign-out
 * that reported success. The value is empty and `Max-Age=0`.
 */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`
}
