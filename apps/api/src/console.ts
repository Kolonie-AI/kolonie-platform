import { z } from 'zod'
import {
  CONSOLE_SESSION_TTL_MS,
  type AgentId,
  type ApiError,
  type CredentialId,
} from '@kolonie-ai/core'
import {
  redeemSignInLink,
  registerWebIdentity,
  requestSignInLink,
  resolveSignInAddress,
  revokeSession,
  type Database,
} from '@kolonie-ai/db'
import type { Mailer } from './email.js'
import { ClaimedAddressSchema } from './email.js'
import { AgentProfileSchema } from '@kolonie-ai/core'
import type { RateLimiter } from './rate-limit.js'

/**
 * The console's front door: ask for a link, follow it, get a session (`#172`).
 *
 * ## What is never in a response body
 *
 * The token and the session value. The link is delivered by mail and by no other
 * channel, and the session leaves in a `Set-Cookie` header. The rule this obeys
 * is the one `credentials.ts` states in the schema — *"`secret_hash` exists here
 * and must never be added to the core shape, and must never appear in a response
 * body"* — and `console.test.ts` greps the serialised responses rather than
 * trusting that it is still true.
 *
 * ## What a caller can and cannot learn
 *
 * Requesting a link answers identically for a known and an unknown address, and
 * so does signing up. Otherwise the form is an oracle for *is this address a
 * citizen*, and D-044 — one address names one citizen — makes that oracle exact
 * rather than statistical. This is the single property that most of the shapes
 * below exist to preserve, which is why the outcomes are collapsed here rather
 * than at the route.
 */

/** Everything the console needs from storage. A port, so these tests need no database. */
export interface ConsoleStore {
  /** Which identity this address names, if any — preferring the proved reach address. */
  resolveAddress(address: string): Promise<{ agentId: AgentId; address: string } | undefined>
  /** Mint a single-use link for an already-resolved identity. */
  requestLink(identity: {
    agentId: AgentId
    address: string
  }): Promise<{ token: string; address: string; expiresAt: string }>
  /** Exchange a token for a session, or refuse. */
  redeem(token: string): Promise<
    | {
        outcome: 'signed-in'
        agentId: AgentId
        credentialId: CredentialId
        session: string
        expiresAt: string
      }
    | { outcome: 'refused' }
  >
  /** Create a thin identity from the sign-up form. */
  registerWeb(request: {
    name: string
    address: string
  }): Promise<
    | { outcome: 'registered'; identity: { agentId: AgentId; address: string } }
    | { outcome: 'address-taken' }
    | { outcome: 'name-taken'; name: string }
  >
  /** End one session. */
  endSession(agentId: AgentId, credentialId: CredentialId): Promise<void>
}

export interface ConsoleDependencies {
  readonly store: ConsoleStore
  /**
   * Sends the link. Absent means sign-in cannot serve — see {@link consoleUnavailable}.
   *
   * The same port the mailbox rung uses, deliberately: one implementation to
   * configure, one to break, and a Colony that can mail a challenge can mail a
   * sign-in link.
   */
  readonly mailer?: Mailer | undefined
  /**
   * Where a followed link lands, from configuration.
   *
   * `AGENTS.md` §3 keeps host names out of this repository, so the API is handed
   * the base and composes the link — the same reason `challengeDomain` and
   * `capabilityPageUrl` are configuration rather than constants.
   */
  readonly consoleUrl: string
  /** Per-address brake on both endpoints. */
  readonly addressLimiter: RateLimiter
  /**
   * Per-IP brake on both endpoints.
   *
   * **Only meaningful once `kolonie-infra#56` has landed**, because before it the
   * origin sees Traefik rather than the caller. Stated here rather than left as a
   * property of the deployment: a limiter keyed on one address for the whole
   * internet is a limiter that refuses everybody once anybody is noisy, which is
   * why the address limiter above is the one that carries the weight today.
   */
  readonly clientLimiter: RateLimiter
}

/**
 * The refusal a console with no mailer gives.
 *
 * `internal` rather than a bespoke code, following `emailUnavailable` one module
 * over: from the caller's side an unconfigured Colony and a broken one are the
 * same event, and it has the same remedy — come back later.
 */
export const MAILER_MISSING: ApiError = {
  code: 'internal',
  message:
    'Sign-in is not configured: the Colony has no way to send mail, so a link requested now ' +
    'could never arrive.',
}

/** Set when the console cannot mail, and why. Read once at startup. */
export function consoleUnavailable(mailer: Mailer | undefined): ApiError | undefined {
  return mailer === undefined ? MAILER_MISSING : undefined
}

export const RequestLinkSchema = z.object({ email: ClaimedAddressSchema }).strict()

export const SignUpSchema = z
  .object({ name: AgentProfileSchema.shape.name, email: ClaimedAddressSchema })
  .strict()

export const RedeemSchema = z.object({ token: z.string().min(1).max(256) }).strict()

/**
 * The one answer both the sign-in request and the sign-up give.
 *
 * A constant rather than a value built per branch, because *identical* is the
 * requirement and two code paths that construct an equal object are two code
 * paths that can stop being equal. There is one object and every branch returns
 * it.
 */
export const CHECK_YOUR_MAIL = {
  sent: true,
  message: 'If that address belongs to an identity here, a sign-in link is on its way.',
} as const

export type LinkOutcome =
  { readonly outcome: 'accepted' } | { readonly outcome: 'rejected'; readonly error: ApiError }

function rateLimited(retryAfterSeconds: number): ApiError {
  return {
    code: 'rate_limited',
    message: `Too many sign-in attempts. Try again in ${retryAfterSeconds} seconds.`,
  }
}

/**
 * Ask for a sign-in link.
 *
 * **Mail goes to the stored address, never to the one in the request.** The
 * request's address is used to look an identity up and is then dropped; what is
 * mailed is `identity.address`, which came out of the database. An endpoint that
 * mailed the request's address would be an account-takeover primitive, and the
 * two strings being equal in the ordinary case is exactly what makes that bug
 * invisible in testing — so the code never has the option.
 *
 * A caller that names an address belonging to nobody, or one belonging to
 * somebody other than itself, gets {@link CHECK_YOUR_MAIL} either way and no mail
 * is sent in the first case.
 */
export async function requestSignIn(
  address: string,
  clientKey: string,
  deps: ConsoleDependencies,
): Promise<LinkOutcome> {
  const limited = brake(address, clientKey, deps)
  if (limited !== undefined) return { outcome: 'rejected', error: limited }

  const mailer = deps.mailer
  if (mailer === undefined) return { outcome: 'rejected', error: MAILER_MISSING }

  const identity = await deps.store.resolveAddress(address)
  // Nothing is minted and nothing is sent for an address nobody holds. The
  // caller is told the same thing either way, one return statement further down.
  if (identity !== undefined) {
    const link = await deps.store.requestLink(identity)
    await mailer.send({
      to: link.address,
      subject: 'Your Kolonie sign-in link',
      text: signInMailBody(deps.consoleUrl, link.token),
    })
  }

  return { outcome: 'accepted' }
}

/**
 * Sign up from the console.
 *
 * The identity is created and a link is sent in one call, so that a sign-up and
 * a sign-in are the same thing from the browser's side and the form has one
 * button. A taken address creates nothing and mails nothing, and answers exactly
 * as a fresh one does — the address on it already belongs to somebody, and
 * telling the caller so is telling a stranger who is registered here.
 *
 * A taken *name* is answered plainly, and the asymmetry is deliberate: names are
 * already public, `POST /v1/agents/name-check` answers the same question without
 * a credential, and a sign-up that silently failed on a name would leave somebody
 * waiting for mail that is never coming.
 */
export async function signUp(
  request: { name: string; email: string },
  clientKey: string,
  deps: ConsoleDependencies,
): Promise<LinkOutcome | { readonly outcome: 'name-taken'; readonly name: string }> {
  const limited = brake(request.email, clientKey, deps)
  if (limited !== undefined) return { outcome: 'rejected', error: limited }

  const mailer = deps.mailer
  if (mailer === undefined) return { outcome: 'rejected', error: MAILER_MISSING }

  const created = await deps.store.registerWeb({ name: request.name, address: request.email })

  if (created.outcome === 'name-taken') return { outcome: 'name-taken', name: created.name }

  if (created.outcome === 'registered') {
    const link = await deps.store.requestLink(created.identity)
    await mailer.send({
      to: link.address,
      subject: 'Your Kolonie sign-in link',
      text: signInMailBody(deps.consoleUrl, link.token),
    })
  }

  return { outcome: 'accepted' }
}

export type RedeemOutcome =
  | {
      readonly outcome: 'signed-in'
      readonly agentId: AgentId
      readonly credentialId: CredentialId
      /** Goes into the cookie. Never into a body, never into a log line. */
      readonly session: string
      readonly maxAgeSeconds: number
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Follow the link.
 *
 * Every failure is the same refusal: unknown, spent, revoked and expired are
 * four facts and the caller is told none of them.
 */
export async function redeemSignIn(
  token: string,
  clientKey: string,
  deps: ConsoleDependencies,
): Promise<RedeemOutcome> {
  const verdict = deps.clientLimiter.take(clientKey)
  if (!verdict.allowed) {
    return { outcome: 'rejected', error: rateLimited(verdict.retryAfterSeconds) }
  }

  const result = await deps.store.redeem(token)

  if (result.outcome === 'refused') {
    return {
      outcome: 'rejected',
      error: { code: 'unauthorized', message: 'That sign-in link is not valid.' },
    }
  }

  return {
    outcome: 'signed-in',
    agentId: result.agentId,
    credentialId: result.credentialId,
    session: result.session,
    maxAgeSeconds: Math.floor(CONSOLE_SESSION_TTL_MS / 1000),
  }
}

/**
 * Both limiters, in the order that makes the per-address one decisive.
 *
 * The address is counted first because it is the meaningful key today — see the
 * note on `clientLimiter`. Counting the client first would spend the useful
 * allowance on a key that is the same for everybody until `kolonie-infra#56`
 * lands.
 */
function brake(
  address: string,
  clientKey: string,
  deps: ConsoleDependencies,
): ApiError | undefined {
  // Keyed on the normalised address so that `Agent@Example.org` and
  // `agent@example.org` share one allowance. Two spellings of one mailbox are
  // one mailbox, and a limiter that disagreed would be bypassed by shift.
  const byAddress = deps.addressLimiter.take(address.trim().toLowerCase())
  if (!byAddress.allowed) return rateLimited(byAddress.retryAfterSeconds)

  const byClient = deps.clientLimiter.take(clientKey)
  if (!byClient.allowed) return rateLimited(byClient.retryAfterSeconds)

  return undefined
}

/**
 * The mail a citizen actually reads.
 *
 * Plain text and short. It says what the link does and how long it lasts,
 * because a link that silently stops working is indistinguishable from one that
 * never worked — and it names nobody but the recipient.
 */
function signInMailBody(consoleUrl: string, token: string): string {
  return [
    'Somebody asked to sign in to the Kolonie console with this address.',
    '',
    `${consoleUrl.replace(/\/+$/, '')}/sign-in?token=${encodeURIComponent(token)}`,
    '',
    'The link works once and expires in 15 minutes.',
    'If this was not you, nothing has happened and you can ignore this mail.',
  ].join('\n')
}

/**
 * Storage wired to a real database. The only place these two meet.
 *
 * The same arrangement `databaseEmailChallenges` uses, and for the same reason:
 * the handlers above depend on the port, so `apps/api`'s tests need no
 * PostgreSQL, and what the database actually does with a spent token is tested in
 * `packages/db` against a real one.
 */
export function databaseConsoleStore(db: Database): ConsoleStore {
  return {
    resolveAddress: (address) => resolveSignInAddress(db, address),
    requestLink: async (identity) => {
      const link = await requestSignInLink(db, identity)
      return { token: link.token, address: link.address, expiresAt: link.expiresAt }
    },
    redeem: (token) => redeemSignInLink(db, token),
    registerWeb: (request) => registerWebIdentity(db, request),
    endSession: (agentId, credentialId) => revokeSession(db, agentId, credentialId),
  }
}
