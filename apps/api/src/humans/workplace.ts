import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import {
  AgentIdSchema,
  ERROR_STATUS,
  IdentityProviderSchema,
  WORKPLACE_CITIZEN_HEADER,
  type AgentId,
  type Human,
} from '@kolonie-ai/core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { HumanStore } from './humans.js'
import type { ResolvedIdentity } from './auth0.js'

/**
 * The workplace SPA's front door: a PKCE access token, validated here (`#1727`).
 *
 * ## Why a bearer token and not a second cookie
 *
 * `kolonie-docs`' `workplace-spa-uses-an-access-token.md` settles it. The
 * workplace is a separate browser origin from the console, so a cookie would
 * make this API mint and carry a second kind of human session, and bring
 * cross-site cookie semantics and CSRF protection into a service that needs
 * neither once it validates a bearer credential. **The console's cookie
 * authentication is untouched by everything in this file** — nothing here reads
 * a cookie, writes one, or is reachable from the console's routes.
 *
 * ## What is configuration and what is code
 *
 * The issuer, the audience and the workplace origin are **deployment
 * configuration and appear nowhere in this repository**, including in its
 * tests. That is `AGENTS.md` §3 and the decision record's own condition, and it
 * is why {@link workplaceTokens} takes them as arguments rather than reading an
 * environment variable: a test supplies its own throwaway values, and the
 * repository never learns the real ones.
 *
 * ## Why the pair and never the token's own identity
 *
 * A validated token yields `(provider, subject)`, which is what
 * `findHumanByIdentity` matches a person on. Nothing here invents a
 * SPA-specific human, keys a person on a client identifier, or writes an
 * identity — the console remains the path that creates (`#1764`). The two
 * doors still resolve to one person, because they match the same pair.
 */

/** The scheme this door accepts, as it appears in the header and in `WWW-Authenticate`. */
export const WORKPLACE_SCHEME = 'Bearer'

/**
 * Everything the workplace door needs from a deployment.
 *
 * `issuer` and `audience` are compared exactly against the token's claims;
 * `origin` is compared exactly against a browser's `Origin` header. All three
 * are opaque strings to this module, which is the property that keeps them out
 * of the repository.
 */
export interface WorkplaceOptions {
  /** The `iss` a token must carry, exactly. */
  readonly issuer: string
  /** The `aud` a token must carry — one of them, where the token carries several. */
  readonly audience: string
  /**
   * The single browser origin this API answers the workplace on.
   *
   * **One origin and never a list**, which is the decision record's condition
   * rather than a simplification: *"the CORS allow-list must not use a wildcard
   * and must not add the console origin by reflex"*. A field that took several
   * would be a field somebody adds the console to.
   */
  readonly origin: string
  /**
   * Where the signing keys are fetched from.
   *
   * Injected so a test can hand over a local key set and this module needs no
   * network. Production passes nothing and gets {@link remoteJwks}, which caches
   * and rotates the way a JWKS endpoint expects.
   */
  readonly keys?: JWTVerifyGetKey
}

/** Who a validated token turned out to be, or why it was refused. */
export type WorkplaceOutcome =
  | { readonly outcome: 'authenticated'; readonly human: Human }
  /**
   * The token did not validate, or validated to nothing this Colony knows.
   *
   * **One refusal for every way of failing**, which is `UNAUTHENTICATED`'s rule
   * in `authentication.ts` restated at this door: a missing header, an expired
   * token, a wrong issuer, a wrong audience and a forged signature are one
   * answer, byte for byte. Any variation is an oracle — a caller holding a
   * harvested token would learn from *expired* that it was once real, and from
   * *wrong audience* that a differently-scoped guess is worth making — and the
   * caller's next step is the same in all of them: sign in again.
   */
  | { readonly outcome: 'rejected' }

/**
 * The claims this door reads, once `jwtVerify` has accepted the token.
 *
 * `sub` only. **Not `email`, not a name, not a client identifier**: the person
 * is resolved on the pair, and every other claim is either something the Colony
 * already holds against that person or something it has decided not to hold.
 */
interface WorkplaceClaims extends JWTPayload {
  readonly sub?: string
}

/**
 * The remote key set, built once per deployment.
 *
 * `jose` caches inside this object and refetches on an unknown `kid`, so
 * building it per request would fetch the JWKS per request and turn every API
 * call into a round trip to the tenant.
 */
export function remoteJwks(issuer: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL('.well-known/jwks.json', ensureTrailingSlash(issuer)))
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

/**
 * Turn an `Authorization` header into the person behind it, or a refusal.
 *
 * **The signature, the issuer and the audience are all checked by `jwtVerify`
 * itself**, in one call, rather than by reading claims off a decoded payload
 * afterwards. Decoding first and comparing later is the shape in which somebody
 * eventually compares a claim from a token whose signature was never checked;
 * passing the constraints in means an unsigned token never reaches the
 * comparison at all.
 */
export async function authenticateWorkplace(
  header: string | undefined,
  store: HumanStore,
  options: WorkplaceOptions,
): Promise<WorkplaceOutcome> {
  const token = workplaceToken(header)
  if (token === undefined) return { outcome: 'rejected' }

  const keys = options.keys ?? remoteJwks(options.issuer)

  let claims: WorkplaceClaims
  try {
    const verified = await jwtVerify<WorkplaceClaims>(token, keys, {
      issuer: options.issuer,
      audience: options.audience,
    })
    claims = verified.payload
  } catch {
    /**
     * **Every failure lands here and answers identically**, including the ones
     * that are the Colony's fault rather than the caller's: an unreachable JWKS
     * endpoint refuses the call the way an expired token does. That is the one
     * place this refusal is knowingly imprecise, and it is the safe direction —
     * a door that answered *the Colony cannot check right now* would be a door
     * an attacker can ask to keep saying it.
     */
    return { outcome: 'rejected' }
  }

  const identity = identityFrom(claims)
  if (identity === undefined) return { outcome: 'rejected' }

  /**
   * **Lookup only (`#1764`).** The SPA never creates a Colony human. An
   * unknown pair is the same `rejected` as a bad token — no oracle, no
   * `findOrCreate`. The console remains the path that writes a person.
   */
  const human = await store.findByIdentity(identity)
  if (human === undefined) return { outcome: 'rejected' }

  return { outcome: 'authenticated', human }
}

/**
 * The token inside an `Authorization` header, if there is one.
 *
 * The scheme is matched case-insensitively because RFC 7235 defines it that way
 * — `bearerToken` in `authentication.ts` gives the same reason for the same
 * decision, and the two doors agree by both reading the specification rather
 * than by one importing the other.
 */
export function workplaceToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined

  const separator = header.indexOf(' ')
  if (separator === -1) return undefined

  const scheme = header.slice(0, separator)
  if (scheme.toLowerCase() !== WORKPLACE_SCHEME.toLowerCase()) return undefined

  const token = header.slice(separator + 1).trim()
  return token === '' ? undefined : token
}

/**
 * The `(provider, subject)` pair a validated token names, or nothing.
 *
 * **The same split `readProfile` performs on `/userinfo`'s `sub`**, deliberately
 * duplicated here rather than shared, because the two are reading different
 * documents that happen to agree today: one is a profile the tenant composed
 * for the console and one is a claim in a token minted for the workplace. A
 * shared helper would make a change to either one silently change the other.
 *
 * `email` is `null` on this path always. The console's callback is where an
 * address is read and verified; a token audience-scoped to this API is not a
 * place the Colony should learn a new address from, and a returning person's
 * address is refreshed by the door that verified it.
 */
export function identityFrom(claims: WorkplaceClaims): ResolvedIdentity | undefined {
  const sub = claims.sub
  if (typeof sub !== 'string' || sub === '') return undefined

  const separator = sub.indexOf('|')
  if (separator <= 0 || separator === sub.length - 1) return undefined

  const strategy = sub.slice(0, separator)
  const subject = sub.slice(separator + 1)

  const provider = IdentityProviderSchema.safeParse(strategyToProvider(strategy))
  if (!provider.success) return undefined

  return { provider: provider.data, subject, email: null }
}

/**
 * A strategy this build has a provider name for, or the strategy unchanged.
 *
 * The three disagreements are the ones `auth0.ts` records: Google's strategy is
 * `google-oauth2`, X's kept its old name, and every database connection arrives
 * as `auth0`. An unrecognised strategy falls through and is refused by the
 * schema above rather than invented — a wrong half of the pair is an account
 * that cannot be signed into twice.
 */
function strategyToProvider(strategy: string): string {
  if (strategy === 'google-oauth2') return 'google'
  if (strategy === 'twitter') return 'x'
  if (strategy === 'auth0') return 'password'
  return strategy
}

/**
 * Whether a browser's `Origin` is the one workplace origin this API answers.
 *
 * **Compared as a string and never parsed into a pattern.** A browser sends the
 * serialised origin, and anything cleverer than equality — a suffix match, a
 * host comparison that ignores the port, a regular expression — is the shape in
 * which `workplace.example.evil` matches a rule written for
 * `workplace.example`.
 *
 * **A request with no `Origin` at all is not a disallowed origin.** A
 * same-origin fetch and every non-browser client send none, and answering them
 * `401` would refuse the API's own callers on a header the browser decides. The
 * credential is what authorises; this decides only whether a browser is
 * permitted to read the answer.
 */
export function originAllowed(origin: string | undefined, allowed: string): boolean {
  if (origin === undefined) return true
  return origin === allowed
}

/**
 * The `Origin` header as one string, or nothing.
 *
 * A header sent twice arrives as an array, and a browser never does that — so
 * an array is a client that is not a browser and gets the same answer as one
 * that sent nothing: the credential decides, and no cross-origin read is
 * permitted on the strength of it.
 */
export function originHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return value
}

/**
 * The two headers a browser needs to read a cross-origin answer.
 *
 * **`Vary: Origin` is not optional here.** This API is served through a cache,
 * and a response whose `Access-Control-Allow-Origin` depends on the request's
 * `Origin` must say so, or the cache serves one origin's answer — allowed or
 * refused — to the next origin that asks.
 *
 * **`Access-Control-Allow-Credentials` is deliberately absent.** The SPA sends a
 * bearer token and no cookie, so nothing here needs credentialed CORS, and
 * setting it would be inviting a browser to attach the console's cookies to a
 * request this API answers at another origin.
 */
export function corsHeaders(reply: FastifyReply, allowed: string): FastifyReply {
  return reply
    .header('access-control-allow-origin', allowed)
    .header('vary', 'Origin')
    .header('access-control-expose-headers', 'etag')
}

/**
 * Methods and headers a later board/card route is allowed to preflight
 * (`#1764`).
 *
 * **One list**, so `/me` and `/actor` and every route `#1759` adds advertise
 * the same set rather than rediscovering CORS per path. `x-kolonie-citizen`
 * is here because citizen-scoped writes send it; `if-match` and
 * `idempotency-key` are what those writes will need.
 */
export const WORKPLACE_CORS_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'
export const WORKPLACE_CORS_HEADERS =
  'authorization, content-type, if-match, x-kolonie-citizen, idempotency-key'

export function workplacePreflight(reply: FastifyReply, allowed: string): FastifyReply {
  return corsHeaders(reply, allowed)
    .status(204)
    .header('access-control-allow-methods', WORKPLACE_CORS_METHODS)
    .header('access-control-allow-headers', WORKPLACE_CORS_HEADERS)
    .header('access-control-max-age', '86400')
}

/**
 * The `401`, in one place so that no path out of this door can be the one that
 * forgets `WWW-Authenticate`.
 */
export function unauthorizedWorkplace(
  reply: FastifyReply,
  allowed: string,
  origin: string | undefined,
) {
  if (origin !== undefined) corsHeaders(reply, allowed)
  return reply
    .status(ERROR_STATUS.unauthorized)
    .header('www-authenticate', WORKPLACE_SCHEME)
    .send({
      code: 'unauthorized',
      message:
        `Present a workplace access token as \`Authorization: ${WORKPLACE_SCHEME} <token>\`. ` +
        'Sign in again to obtain one.',
    })
}

export function forbiddenWorkplaceOrigin(reply: FastifyReply) {
  return reply.status(ERROR_STATUS.forbidden).send({
    code: 'forbidden',
    message: 'This API answers the workplace at one configured origin and at no other.',
  })
}

export type WorkplaceActorResult = {
  readonly human: Human
  readonly citizenId: AgentId
  readonly origin: string | undefined
}

/**
 * Origin, bearer, then the citizen header (`#1764`).
 *
 * **The actor on Workplace HTTP is a citizen, named explicitly.** `/me` does
 * not use this — it is how the SPA learns the list. Every later citizen-scoped
 * route does. A missing header is `400`; an unlinked or unparseable id is
 * `workplace_unknown_citizen` and does not say whether the agent exists.
 *
 * **Writes the refusal itself** so a board route cannot forget CORS, the
 * `WWW-Authenticate` header, or the origin-before-JWT order. `undefined`
 * means the reply is already on its way.
 */
export async function workplaceActorFor(
  request: FastifyRequest,
  reply: FastifyReply,
  store: HumanStore,
  options: WorkplaceOptions,
): Promise<WorkplaceActorResult | undefined> {
  const origin = originHeader(request.headers.origin)

  if (!originAllowed(origin, options.origin)) {
    forbiddenWorkplaceOrigin(reply)
    return undefined
  }

  const outcome = await authenticateWorkplace(request.headers.authorization, store, options)
  if (outcome.outcome === 'rejected') {
    unauthorizedWorkplace(reply, options.origin, origin)
    return undefined
  }

  const raw = request.headers[WORKPLACE_CITIZEN_HEADER]
  const presented = typeof raw === 'string' ? raw.trim() : undefined
  if (presented === undefined || presented === '') {
    if (origin !== undefined) corsHeaders(reply, options.origin)
    reply.status(400).send({
      code: 'validation_failed',
      message: `Name the citizen you are acting as in \`${WORKPLACE_CITIZEN_HEADER}\`.`,
      details: { [WORKPLACE_CITIZEN_HEADER]: 'required' },
    })
    return undefined
  }

  const parsed = AgentIdSchema.safeParse(presented)
  if (!parsed.success || !(await store.operates(outcome.human.id, parsed.data))) {
    if (origin !== undefined) corsHeaders(reply, options.origin)
    reply.status(ERROR_STATUS.workplace_unknown_citizen).send({
      code: 'workplace_unknown_citizen',
      message: 'No citizen matches the id you named.',
    })
    return undefined
  }

  return { human: outcome.human, citizenId: parsed.data, origin }
}
