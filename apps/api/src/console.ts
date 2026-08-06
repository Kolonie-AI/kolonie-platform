import { z } from 'zod'
import {
  CONSOLE_SESSION_TTL_MS,
  type AgentId,
  type ApiError,
  type CredentialId,
  type Log,
} from '@kolonie-ai/core'
import {
  redeemKeyMintLink,
  redeemSignInLink,
  registerWebIdentity,
  requestKeyMintLink,
  requestSignInLink,
  resolveSignInAddress,
  revokeSession,
  signInAddressOf,
  type Database,
  type RefusalReason,
} from '@kolonie-ai/db'
import type { Mailer, OperatorMailer } from './email.js'
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

/**
 * Where a followed link lands — **one constant, and that is the point** (`#396`).
 *
 * The mail said `/sign-in?token=…` and the route was registered at
 * `/sign-in/redeem`. Neither was wrong on its own; they were two strings for one
 * path, written five hundred lines apart, and they had never agreed. Every link
 * the Colony has ever mailed to a human was a `404` — rendered, until this
 * change, as the sign-in form, so it read as an expired link and the reader
 * tried again.
 *
 * `registerConsolePages` registers this exact value and {@link signInLinkUrl}
 * builds this exact value. A path that appears once cannot drift from itself.
 */
export const SIGN_IN_REDEEM_PATH = '/sign-in/redeem'

/**
 * Where the provider sends a browser back (`#425`), for the same reason.
 *
 * **This value is registered on the tenant as an allowed callback**, so the
 * string here and the string there have to agree exactly — a redirect URI that
 * differs by a character is refused by the provider with an error page the
 * Colony does not control. `#396` is what a path written twice looks like when
 * it drifts; this one drifts against somebody else's configuration, which is
 * worse, so it appears once and `server.ts` composes the absolute form from it.
 */
export const SIGN_IN_CALLBACK_PATH = '/sign-in/callback'

/** The absolute link that goes in the mail. The only place a token meets a URL. */
export function signInLinkUrl(consoleUrl: string, token: string): string {
  return `${consoleUrl.replace(/\/+$/, '')}${SIGN_IN_REDEEM_PATH}?token=${encodeURIComponent(token)}`
}

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
    | { outcome: 'refused'; reason: RefusalReason }
  >
  /** Create a thin identity from the sign-up form. The name is the Colony's if absent. */
  registerWeb(request: {
    name?: string | undefined
    address: string
  }): Promise<
    | { outcome: 'registered'; identity: { agentId: AgentId; address: string } }
    | { outcome: 'address-taken' }
    | { outcome: 'name-taken'; name: string }
  >
  /** End one session. */
  endSession(agentId: AgentId, credentialId: CredentialId): Promise<void>
  /**
   * Mint the confirmation link that lets this identity take an API key (`#400`).
   *
   * Takes the identity and never an address: what is mailed is read from
   * storage, exactly as {@link requestLink} does, so a request body can never
   * decide where a credential's confirmation goes.
   */
  requestKeyMint(agentId: AgentId): Promise<{ token: string; address: string } | undefined>
  /** Exchange a confirmation token for a key, once, or refuse. */
  redeemKeyMint(
    token: string,
  ): Promise<{ outcome: 'minted'; apiKey: string } | { outcome: 'refused' }>
}

export interface ConsoleDependencies {
  readonly store: ConsoleStore
  /**
   * Sends the link. Absent means sign-in cannot serve — see {@link consoleUnavailable}.
   *
   * The same port the mailbox rung uses, deliberately: one implementation to
   * configure, one to break, and a Colony that can mail a challenge can mail a
   * sign-in link.
   *
   * **Bound to the console's sender (`#474`).** It used to be a bare `Mailer`
   * beside a `senderAddress` field that each of the four sends in this module
   * had to remember to pass. Three did and the deletion notice did not, and the
   * same shape had already lost the autonomy request entirely. The address is
   * now chosen once, in `mail-config.ts`, and carried by the type.
   */
  readonly mailer?: OperatorMailer | undefined
  /**
   * Where a followed link lands, from configuration.
   *
   * `AGENTS.md` §3 keeps host names out of this repository, so the API is handed
   * the base and composes the link — the same reason `challengeDomain` and
   * `capabilityPageUrl` are configuration rather than constants.
   */
  readonly consoleUrl: string
  /**
   * Where this module says the things it must not tell the caller (`#406`).
   *
   * **Required, not optional, and that is the whole point of the field.** An
   * optional log defaults to silence, and a deployment that forgot to wire it
   * would be indistinguishable from the defect this fixes — a console send that
   * fails and leaves no trace anywhere. The type is what makes the wiring
   * impossible to forget, so every construction site says `silentLog` on
   * purpose rather than by omission.
   *
   * The shape is `recheck`'s. What is different is the reason: `recheck` logs
   * because nobody is watching that path, and this one logs because the caller
   * **must not be told** — see {@link recordUndelivered}.
   */
  readonly log: Log
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
export function consoleUnavailable(
  mailer: Mailer | OperatorMailer | undefined,
): ApiError | undefined {
  return mailer === undefined ? MAILER_MISSING : undefined
}

export const RequestLinkSchema = z.object({ email: ClaimedAddressSchema }).strict()

/**
 * A sign-up is an address, and may carry a name (`#266`).
 *
 * **Optional rather than required**, which is `#180`'s unmet criterion: the
 * console's form sends the address alone and the Colony generates a name that
 * says nothing about it. An agent posting JSON may still choose one, because it
 * has a name already and would rather be called by it than by a generated
 * string — the field did not become useless, it stopped being a toll.
 */
export const SignUpSchema = z
  .object({ name: AgentProfileSchema.shape.name.optional(), email: ClaimedAddressSchema })
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

/**
 * Record a console send that was not delivered, where the caller cannot see it
 * (`#406`).
 *
 * **`cloudflareMailer` returns a failure rather than throwing it**, so a refused
 * send was invisible in both directions at once: the reader was told *check your
 * mail* and waited for a mail that had never been accepted, and nothing anywhere
 * recorded that it had not. The only evidence a send was attempted was a
 * `credentials` row of kind `email-link`, which is written whether or not the
 * mail left. Measured on production 2026-08-05, the api container's whole log
 * output since its last start was one line, `service.started`.
 *
 * **Four of the six send sites in this repository already check.**
 * `academy/email`, `recheck`, `autonomy` and `operator-requests` all read
 * `delivered` and answer the caller accordingly — `autonomy` even has copy
 * written for it. The two console calls could not, and the reason is the
 * interesting part of this issue rather than an oversight:
 *
 * **The console must not tell the caller.** `requestSignIn` answers identically
 * for an address that names somebody and one that names nobody — D-044 makes
 * that exact rather than statistical — and a mail is only ever attempted when an
 * identity exists. So *"the Colony could not deliver the mail"* is a sentence
 * that can only occur for a registered address, which makes it **a perfect
 * oracle for which addresses have accounts**: precisely what
 * {@link CHECK_YOUR_MAIL} is written to prevent. `signUp` has the same shape one
 * step along, where a fresh address sends and a taken one does not.
 *
 * So the answer goes somewhere the caller cannot see, and that is a log line.
 *
 * **The address is not in it, and that is not caution — it is the same rule.**
 * It is the identifier this whole flow is arranged to protect, and a log line is
 * not a private place. What goes in is what a reader needs to find the failure:
 * which surface, and what the mailer said about itself.
 */
function recordUndelivered(
  deps: ConsoleDependencies,
  surface: 'sign-in' | 'sign-up' | 'key-mint',
  sent: { readonly delivered: boolean; readonly reason?: string },
): void {
  if (sent.delivered) return

  deps.log.warn(`a console ${surface} mail could not be delivered`, {
    event: 'console.mail.failed',
    surface,
    reason: sent.reason ?? null,
  })
}

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
    const sent = await mailer.send({
      to: link.address,
      subject: SIGN_IN_SUBJECT,
      text: signInMailBody(deps.consoleUrl, link.token),
    })
    // Recorded, never answered. See recordUndelivered for why this one branch
    // cannot reach the caller the way the other four send sites do.
    recordUndelivered(deps, 'sign-in', sent)
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
  request: { name?: string | undefined; email: string },
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
    const sent = await mailer.send({
      to: link.address,
      subject: NEW_ACCOUNT_SUBJECT,
      text: newAccountMailBody(deps.consoleUrl, link.token),
    })
    recordUndelivered(deps, 'sign-up', sent)
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
 * What a reader is told when a link buys nothing.
 *
 * **A caller holding a token the Colony minted is told which of the two
 * ordinary things happened**, and a caller holding a guess is told nothing —
 * the reasoning is on `RefusalReason` in `packages/db`. Each sentence ends with
 * the same instruction, because in all three cases the reader's next move is
 * identical and the page they were shown before `#396` did not say it.
 */
const REFUSAL_MESSAGE: Readonly<Record<RefusalReason, string>> = {
  unknown: 'That sign-in link is not valid. Ask for a new one below.',
  spent: 'That sign-in link has already been used. Ask for a new one below.',
  expired: 'That sign-in link has expired. Ask for a new one below.',
}

/**
 * Follow the link.
 *
 * The refusal carries a reason, and {@link REFUSAL_MESSAGE} decides how much of
 * it is said out loud.
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
      error: { code: 'unauthorized', message: REFUSAL_MESSAGE[result.reason] },
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

/** Where the confirmation link lands. One place, so it cannot drift from itself. */
export const KEY_MINT_CONFIRM_PATH = '/key/confirm'

/** The absolute link that goes in the key-mint mail. */
export function keyMintLinkUrl(consoleUrl: string, token: string): string {
  return `${consoleUrl.replace(/\/+$/, '')}${KEY_MINT_CONFIRM_PATH}?token=${encodeURIComponent(token)}`
}

/** The subject on the one mail this route sends. */
export const KEY_MINT_SUBJECT = 'Confirm the API key for your Kolonie account'

/**
 * The mail that has to be followed before a key exists (`#400`).
 *
 * **It describes the act that produced it**, which is `#398`'s lesson: a person
 * who pressed *give me a key* and received a mail saying *somebody asked to sign
 * in* is left working out whether their click did anything.
 *
 * It also states the one thing a person can act on if the request was not
 * theirs: nothing has happened yet, and ignoring the mail is the whole of the
 * remedy.
 */
function keyMintMailBody(consoleUrl: string, token: string): string {
  return [
    'Somebody asked for an API key on your Kolonie account. Following this link',
    'creates one:',
    '',
    keyMintLinkUrl(consoleUrl, token),
    '',
    'The key is shown once, on the page the link opens, and cannot be read again',
    'afterwards. Your account keeps working in the browser exactly as it does now —',
    'a key is a second way in, not a replacement.',
    '',
    'The link works once and expires in 15 minutes.',
    'If this was not you, no key has been created and you can ignore this mail.',
  ].join('\n')
}

/**
 * Ask for the key confirmation (`#400`).
 *
 * **The identity comes from the session and the address from storage.** There is
 * no parameter here anybody could aim at another account, and nothing the
 * request said decides where the mail goes — the same shape `requestSignIn` has,
 * and for the same reason: a route that mails a credential's confirmation
 * wherever it is told is an account-takeover primitive with a friendly name.
 *
 * **An account the Colony has no address for is told so**, rather than being
 * shown *check your mail* about a mail that was never sent. That case cannot
 * arise for an account opened through the console, which is exactly why leaving
 * it silent would make it undiscoverable when it does.
 */
export async function requestKeyMint(
  agentId: AgentId,
  deps: ConsoleDependencies,
): Promise<LinkOutcome> {
  if (deps.mailer === undefined) return { outcome: 'rejected', error: MAILER_MISSING }

  const link = await deps.store.requestKeyMint(agentId)
  if (link === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'This account has no address the Colony can write to, so a key cannot be confirmed. ' +
          'That should not be possible for an account opened here — please report it.',
      },
    }
  }

  const sent = await deps.mailer.send({
    to: link.address,
    subject: KEY_MINT_SUBJECT,
    text: keyMintMailBody(deps.consoleUrl, link.token),
  })
  /**
   * **A third console send, which `#406` counts as two.**
   *
   * That issue says the two calls above are the only ones in this repository
   * that do not read `delivered`; `#400` added this one afterwards, with the
   * same gap. It is covered here rather than left for a second issue, because
   * *the console records a send it could not make* is one property and a module
   * where it holds in two places out of three is a module nobody can rely on.
   *
   * **What is not copied across is the silence.** The reader here is signed in
   * and asking about its own account, so telling it that delivery failed reveals
   * nothing it does not already know — there is no oracle to protect. That is a
   * separate change to what this route answers, and this issue is about the
   * record rather than the reply.
   */
  recordUndelivered(deps, 'key-mint', sent)

  return { outcome: 'accepted' }
}

/** The key, once, or a refusal. */
export type KeyMintOutcome =
  | { readonly outcome: 'minted'; readonly apiKey: string }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Follow the confirmation and take the key (`#400`).
 *
 * **One refusal for every way a token can fail**, unlike `redeemSignIn`. That
 * one distinguishes *spent* from *expired* because a sponsor stuck at a sign-in
 * form has nowhere else to go; here the reader is already signed in and lands
 * back on a page carrying the button, so *ask for another* is the whole of the
 * instruction in every case.
 */
export async function redeemKeyMint(
  token: string,
  deps: ConsoleDependencies,
): Promise<KeyMintOutcome> {
  const result = await deps.store.redeemKeyMint(token)

  if (result.outcome === 'refused') {
    return {
      outcome: 'rejected',
      error: {
        code: 'unauthorized',
        message: 'That confirmation link is no longer usable. Ask for another one.',
      },
    }
  }

  return { outcome: 'minted', apiKey: result.apiKey }
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

/** The subject on a link asked for by somebody who already has an account. */
export const SIGN_IN_SUBJECT = 'Your Kolonie sign-in link'

/** The subject on the first mail an account ever gets (`#398`). */
export const NEW_ACCOUNT_SUBJECT = 'Your Kolonie sponsor account is open'

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
    signInLinkUrl(consoleUrl, token),
    '',
    'The link works once and expires in 15 minutes.',
    'If this was not you, nothing has happened and you can ignore this mail.',
  ].join('\n')
}

/**
 * The first mail an account ever gets, and it describes the act that produced it
 * (`#398`).
 *
 * **It said *somebody asked to sign in*, to a person who had just clicked *open
 * an account*.** They were left to work out whether their click had done
 * anything, from a mail describing an act they had not performed — and the
 * maintainer's verdict on the sequence was that *"it is written so badly that
 * you cannot understand what you are supposed to do"*.
 *
 * So this one says three things the sign-in mail has no business saying: that
 * the account exists, what it holds — nothing — and what the link is for. The
 * last two lines are the sign-in mail's, unchanged, because they are true of
 * every link the console mails.
 */
function newAccountMailBody(consoleUrl: string, token: string): string {
  return [
    'Your Kolonie sponsor account is open. This link is how you get into it:',
    '',
    signInLinkUrl(consoleUrl, token),
    '',
    'A sponsor account starts empty and stays empty: no skills, no reputation,',
    'and no place in any quest’s audience. What it holds is a balance and the',
    'quests you write against it — and nothing can be funded until you have',
    'followed this link once.',
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
    requestKeyMint: async (agentId) => {
      /**
       * The address is read first and the link is minted only if there is one.
       * An account with no address to write to must not have a live
       * confirmation nobody could ever follow.
       */
      const address = await signInAddressOf(db, agentId)
      if (address === undefined) return undefined

      const link = await requestKeyMintLink(db, agentId)
      return { token: link.token, address }
    },
    redeemKeyMint: async (token) => {
      const result = await redeemKeyMintLink(db, token)
      return result.outcome === 'minted'
        ? { outcome: 'minted' as const, apiKey: result.apiKey }
        : { outcome: 'refused' as const }
    },
  }
}
