import { randomBytes } from 'node:crypto'
import { IdentityProviderSchema, type IdentityProvider } from '@kolonie-ai/core'

/**
 * The identity provider, as a seam (`#425`).
 *
 * ## Why a hosted redirect and not five OAuth clients
 *
 * `kolonie-docs#170` decides it: two providers is an afternoon and five is a
 * standing maintenance load on the login path, which is the path where a defect
 * is an account takeover rather than a broken page. Universal Login is a hosted
 * page, so the console's `default-src 'none'` and its complete absence of
 * JavaScript both survive — nothing renders here, the browser is simply sent
 * somewhere and comes back.
 *
 * Clerk was refused for the opposite reason: React-component-first, and it would
 * have fought a server-rendered console.
 *
 * ## What this module is careful about
 *
 * **Auth0's session is not the Colony's session.** What comes back from the
 * callback is an identity, and the Colony issues its own cookie for it. Nothing
 * downstream of {@link exchangeCode} knows a tenant exists, which is what makes
 * a second provider — or a different vendor entirely — a change confined to this
 * file.
 *
 * **The identity is read from the tenant over TLS, never from the request.** The
 * `code` is a bearer of nothing; the profile is fetched with the token minted
 * against it. That is the D-018 property the Academy's `xAdapter` certifies on,
 * one layer down: the identifier arrives from the platform and never from the
 * payload.
 */
export interface IdentityProviderTenant {
  /**
   * Where to send a browser to sign in.
   *
   * `connection` names the door, so the person lands on the provider they
   * pressed rather than on a chooser page repeating the choice they just made.
   * That mattered less when GitHub was the only door and matters more now that
   * it is not. `state` is the caller's, and comes back untouched.
   */
  authorizeUrl(input: { readonly connection: IdentityProvider; readonly state: string }): string
  /** Turn a callback code into the identity behind it, or nothing. */
  exchangeCode(code: string): Promise<ResolvedIdentity | undefined>
}

/** Who came back, once the tenant has been asked. */
export interface ResolvedIdentity {
  readonly provider: IdentityProvider
  readonly subject: string
  /** `null` where the provider returned no usable address — see `#426`. */
  readonly email: string | null
}

export interface Auth0Options {
  readonly domain: string
  readonly clientId: string
  readonly clientSecret: string
  /** Must match a callback registered on the tenant, exactly. */
  readonly redirectUri: string
  readonly fetchImpl?: typeof fetch
}

/**
 * Mint the one-time value that ties a callback to the browser that started it.
 *
 * Not a nicety: without it, an attacker's callback can be delivered to somebody
 * else's browser and sign them into the attacker's account. 256 bits, from the
 * same source as every other secret here.
 */
export function mintOauthState(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * An `IdentityProviderTenant` backed by a real Auth0 tenant.
 *
 * **`/userinfo` rather than decoding the `id_token`.** Both carry the same
 * claims and only one of them needs a JWKS fetch, a key cache and signature
 * verification written correctly — a dependency and a class of subtle bug, for a
 * saving of one HTTPS request on a path a person walks once a fortnight. The
 * token this asks with was minted seconds earlier against our own client secret,
 * so the answer is as trustworthy as the signature would have been.
 */
export function auth0Tenant(options: Auth0Options): IdentityProviderTenant {
  const doFetch = options.fetchImpl ?? fetch
  const origin = `https://${options.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`

  return {
    authorizeUrl: ({ connection, state }) => {
      const query = new URLSearchParams({
        client_id: options.clientId,
        response_type: 'code',
        redirect_uri: options.redirectUri,
        // `openid` for the subject, `email` for the address `#426` needs where
        // the provider will give one. No `profile`: a name the Colony does not
        // display is personal data it would be holding for nothing.
        scope: 'openid email',
        connection: providerToConnection(connection),
        state,
      })
      return `${origin}/authorize?${query.toString()}`
    },

    exchangeCode: async (code) => {
      const tokenResponse = await doFetch(`${origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: options.redirectUri,
        }),
        signal: AbortSignal.timeout(15_000),
      })

      if (!tokenResponse.ok) return undefined

      const token = (await tokenResponse.json()) as { access_token?: unknown }
      if (typeof token.access_token !== 'string' || token.access_token === '') return undefined

      const profileResponse = await doFetch(`${origin}/userinfo`, {
        headers: { authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(15_000),
      })

      if (!profileResponse.ok) return undefined

      const profile = (await profileResponse.json()) as {
        sub?: unknown
        email?: unknown
        email_verified?: unknown
      }

      return readProfile(profile)
    },
  }
}

/**
 * Turn a `/userinfo` answer into an identity, or nothing.
 *
 * Exported for its tests: every branch here is a shape somebody else's service
 * decides, and the interesting ones are the ones that are *not* an error.
 */
export function readProfile(profile: {
  sub?: unknown
  email?: unknown
  email_verified?: unknown
}): ResolvedIdentity | undefined {
  if (typeof profile.sub !== 'string' || profile.sub === '') return undefined

  /**
   * Auth0's `sub` is `<strategy>|<subject>`, and both halves are wanted.
   *
   * **Strategy, not connection name.** This comment said *connection* until
   * `#575`, and it was wrong in a way nothing could show: a social connection's
   * default name *is* its strategy, so `github` and `google-oauth2` are both at
   * once and the distinction never surfaced. The database connection is where
   * they part — it is named `Username-Password-Authentication` and its strategy
   * is `auth0`, so a `sub` of `auth0|68f2…` carries a word that appears nowhere
   * in the connection's name. Measured against one real sign-in on 2026-08-08.
   *
   * That is why {@link providerToConnection} and `connectionToProvider` are not
   * inverses of one another and cannot be collapsed into one table: the first
   * answers *where do I send a browser*, which wants the name, and the second
   * answers *who came back*, which is given the strategy.
   *
   * Storing the composite would work until the day a connection is renamed, at
   * which point every returning person becomes a new one. Splitting it means the
   * pair `(provider, subject)` is the provider's own identifier and our own name
   * for the door, neither of which is derived from the other.
   */
  const separator = profile.sub.indexOf('|')
  if (separator <= 0 || separator === profile.sub.length - 1) return undefined

  const connection = profile.sub.slice(0, separator)
  const subject = profile.sub.slice(separator + 1)

  const provider = IdentityProviderSchema.safeParse(connectionToProvider(connection))
  // A connection switched on in the tenant that this build has no name for. The
  // honest answer is to refuse rather than to invent a provider: the pair is a
  // primary key, and a wrong half of it is an account that cannot be signed into
  // twice.
  if (!provider.success) return undefined

  return {
    provider: provider.data,
    subject,
    /**
     * **An unverified address is treated as no address at all.**
     *
     * `#426` writes `operator_addresses` from this, with `confirmed_at` set, and
     * gates two rungs on it. An address a provider has not verified is a claim
     * the person made to somebody else, and confirming it here on that basis
     * would make the Colony's confirmation mean less than the form answer it is
     * supposed to be stronger than. A GitHub account with a private address
     * lands here too, and lands correctly.
     */
    email:
      typeof profile.email === 'string' &&
      profile.email !== '' &&
      profile.email_verified === true &&
      !profile.email.endsWith('@users.noreply.github.com')
        ? profile.email
        : null,
  }
}

/** Auth0's name for the database connection every password person arrives on. */
export const PASSWORD_CONNECTION = 'Username-Password-Authentication'

/**
 * Auth0 names its connections; the Colony names its providers.
 *
 * They agree for the plain social ones and disagree for Google, whose connection
 * is `google-oauth2`, for X, whose kept its old name, and for the password door,
 * whose connection is not named after anything. One table rather than a rule,
 * because the next disagreement will not follow a pattern either.
 *
 * **This is the browser's direction and it wants the connection's name.** Its
 * partner below is given a strategy instead, which is why the two are separate
 * functions rather than one map read in both directions — see `readProfile`.
 */
export function providerToConnection(provider: IdentityProvider): string {
  if (provider === 'google') return 'google-oauth2'
  if (provider === 'x') return 'twitter'
  if (provider === 'password') return PASSWORD_CONNECTION
  return provider
}

/**
 * What came back, read from the `sub` prefix — which is a **strategy**.
 *
 * **`auth0` is a strategy shared by every database connection**, so this maps
 * the strategy and not a connection: a second database connection would arrive
 * here as `auth0` too and be indistinguishable from the first. That is fine
 * while there is one, and the day there are two the pair `(provider, subject)`
 * stops being unique — so a second database connection is a schema question,
 * not a line added here.
 */
function connectionToProvider(connection: string): string {
  if (connection === 'google-oauth2') return 'google'
  // X's connection kept its old name in Auth0, as it has everywhere else.
  if (connection === 'twitter') return 'x'
  if (connection === 'auth0') return 'password'
  return connection
}
