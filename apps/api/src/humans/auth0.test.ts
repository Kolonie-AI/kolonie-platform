import { describe, expect, it } from 'vitest'
import {
  auth0Tenant,
  mintOauthState,
  PASSWORD_CONNECTION,
  providerToConnection,
  readProfile,
} from './auth0.js'
import { browserFamily, coarseLocation, stateMatches } from './humans.js'

/**
 * The identity provider seam (`#425`).
 *
 * Everything here is about a shape somebody else's service decides, which is why
 * the interesting cases are the ones that are **not** an error: a GitHub account
 * with a private address, a connection whose Auth0 name is not the Colony's name
 * for it, and a profile that arrives without the one field the pair depends on.
 */
describe('reading a profile the tenant returned', () => {
  it('splits the connection off the subject rather than storing the composite', () => {
    const identity = readProfile({
      sub: 'github|4815162342',
      email: 'a@b.test',
      email_verified: true,
    })

    expect(identity).toEqual({ provider: 'github', subject: '4815162342', email: 'a@b.test' })
  })

  /**
   * Auth0 names its connections and the Colony names its providers, and they
   * disagree for three of the six. Storing Auth0's name would make a renamed
   * connection turn every returning person into a new one.
   */
  it('knows the connections whose name is not the provider’s', () => {
    expect(readProfile({ sub: 'google-oauth2|1', email_verified: true })?.provider).toBe('google')
    expect(readProfile({ sub: 'twitter|1', email_verified: true })?.provider).toBe('x')
    expect(providerToConnection('google')).toBe('google-oauth2')
    expect(providerToConnection('x')).toBe('twitter')
    expect(providerToConnection('github')).toBe('github')
  })

  /**
   * **The password door is the one where the two directions genuinely differ**
   * (`#575`), and the reason the test above can be read as saying they are
   * inverses. A `sub` carries Auth0's *strategy*; an authorize URL wants the
   * *connection's name*. For every social door those are the same string, which
   * is why nothing here caught it until a database connection existed.
   *
   * Measured against one real sign-in on 2026-08-08: `auth0|<id>`, from a
   * connection named `Username-Password-Authentication`.
   */
  it('reads a password person off the strategy and sends them to the connection', () => {
    expect(readProfile({ sub: 'auth0|6a773e8931e3b099dce8e372' })).toEqual({
      provider: 'password',
      subject: '6a773e8931e3b099dce8e372',
      email: null,
    })

    expect(providerToConnection('password')).toBe(PASSWORD_CONNECTION)
    expect(PASSWORD_CONNECTION).not.toBe('auth0')
  })

  /**
   * The trap the line above would otherwise invite: a reader who believes the
   * two functions are a single table read in both directions would wire the
   * connection's name into `connectionToProvider`, and every password person
   * would be refused as an unknown door.
   */
  it('does not accept the connection’s name where a strategy belongs', () => {
    expect(readProfile({ sub: `${PASSWORD_CONNECTION}|1` })).toBeUndefined()
  })

  it('refuses a connection this build has no name for', () => {
    expect(readProfile({ sub: 'myspace|1' })).toBeUndefined()
  })

  it('refuses a profile with no subject, which is half the primary key', () => {
    expect(readProfile({ email: 'a@b.test', email_verified: true })).toBeUndefined()
    expect(readProfile({ sub: '' })).toBeUndefined()
    expect(readProfile({ sub: 'github|' })).toBeUndefined()
    expect(readProfile({ sub: '|4815162342' })).toBeUndefined()
  })

  /**
   * `#426` writes `operator_addresses` from this with `confirmed_at` set, and
   * gates two rungs on it. An address the provider has not verified is a claim
   * somebody made to somebody else.
   */
  it('treats an unverified address as no address', () => {
    expect(readProfile({ sub: 'github|1', email: 'a@b.test' })?.email).toBeNull()
    expect(
      readProfile({ sub: 'github|1', email: 'a@b.test', email_verified: false })?.email,
    ).toBeNull()
  })

  it('treats GitHub’s noreply address as no address, because no mail reaches it', () => {
    const identity = readProfile({
      sub: 'github|1',
      email: '1+someone@users.noreply.github.com',
      email_verified: true,
    })

    expect(identity?.email).toBeNull()
    // The person is still signed in. A private address costs the operator
    // rungs, and nothing else.
    expect(identity?.subject).toBe('1')
  })
})

describe('the authorize redirect', () => {
  const tenant = auth0Tenant({
    domain: 'tenant.example.test',
    clientId: 'a-client',
    clientSecret: 'a-secret',
    redirectUri: 'https://console.example/sign-in/callback',
  })

  it('names the door, the callback and the state, and asks for no more than it needs', () => {
    const url = new URL(tenant.authorizeUrl({ connection: 'github', state: 'a-state' }))

    expect(url.origin).toBe('https://tenant.example.test')
    expect(url.pathname).toBe('/authorize')
    expect(url.searchParams.get('connection')).toBe('github')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('https://console.example/sign-in/callback')
    expect(url.searchParams.get('state')).toBe('a-state')
    // `openid` for the subject and `email` for the address. Not `profile`: a
    // name the Colony never displays is personal data held for nothing.
    expect(url.searchParams.get('scope')).toBe('openid email')
  })

  it('carries no secret into a URL a browser will hold', () => {
    const url = tenant.authorizeUrl({ connection: 'github', state: 'a-state' })

    expect(url).not.toContain('a-secret')
  })
})

describe('exchanging a code', () => {
  const build = (
    handler: (url: string, init?: RequestInit) => Promise<Response>,
  ): ReturnType<typeof auth0Tenant> =>
    auth0Tenant({
      domain: 'tenant.example.test',
      clientId: 'a-client',
      clientSecret: 'a-secret',
      redirectUri: 'https://console.example/sign-in/callback',
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
        handler(String(input), init)) as unknown as typeof fetch,
    })

  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  it('reads the identity from the tenant and never from the callback', async () => {
    const asked: string[] = []
    const tenant = build(async (url) => {
      asked.push(url)
      return url.endsWith('/oauth/token')
        ? ok({ access_token: 'a-token' })
        : ok({ sub: 'github|99', email: 'someone@example.test', email_verified: true })
    })

    const identity = await tenant.exchangeCode('a-code')

    expect(identity).toEqual({ provider: 'github', subject: '99', email: 'someone@example.test' })
    expect(asked).toEqual([
      'https://tenant.example.test/oauth/token',
      'https://tenant.example.test/userinfo',
    ])
  })

  it('gives nothing back when the tenant refuses the code', async () => {
    const tenant = build(async () => new Response('no', { status: 403 }))

    expect(await tenant.exchangeCode('a-code')).toBeUndefined()
  })

  it('gives nothing back when the token answer carries no token', async () => {
    const tenant = build(async () => ok({ token_type: 'Bearer' }))

    expect(await tenant.exchangeCode('a-code')).toBeUndefined()
  })

  it('gives nothing back when the profile cannot be read', async () => {
    const tenant = build(async (url) =>
      url.endsWith('/oauth/token')
        ? ok({ access_token: 'a-token' })
        : new Response('no', { status: 401 }),
    )

    expect(await tenant.exchangeCode('a-code')).toBeUndefined()
  })
})

describe('the one-time state', () => {
  it('is long, unguessable and never repeated', () => {
    const minted = new Set(Array.from({ length: 50 }, () => mintOauthState()))

    expect(minted.size).toBe(50)
    for (const state of minted) expect(state.length).toBeGreaterThanOrEqual(40)
  })

  it('matches only itself', () => {
    const state = mintOauthState()

    expect(stateMatches(state, state)).toBe(true)
    expect(stateMatches(state, `${state}x`)).toBe(false)
    expect(stateMatches(state, state.slice(0, -1))).toBe(false)
    expect(stateMatches(undefined, state)).toBe(false)
    expect(stateMatches(state, undefined)).toBe(false)
    expect(stateMatches('', '')).toBe(false)
  })
})

describe('what is recorded about where a session came from', () => {
  it('names a browser family and never the string it read', () => {
    expect(
      browserFamily('Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0'),
    ).toBe('Firefox on Linux')
    expect(
      browserFamily(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS')
    // Every one of these strings contains the words of the others, which is why
    // the order the list is tested in is the order it is written in.
    expect(
      browserFamily(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
      ),
    ).toBe('Edge on Windows')
    expect(
      browserFamily(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS')
  })

  it('says nothing at all rather than guessing', () => {
    expect(browserFamily(undefined)).toBeNull()
    expect(browserFamily('')).toBeNull()
    expect(browserFamily('curl/8.5.0')).toBeNull()
  })

  it('keeps a country and never an address', () => {
    expect(coarseLocation({ 'cf-ipcountry': 'de' })).toBe('DE')
    expect(coarseLocation({})).toBeNull()
    // Cloudflare's own answers for *unknown* and *Tor*, which name nowhere.
    expect(coarseLocation({ 'cf-ipcountry': 'XX' })).toBeNull()
    expect(coarseLocation({ 'cf-ipcountry': 'T1' })).toBeNull()
  })
})
