import { fakeArtefactChallenges } from './__fixtures__/artefact.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeDepositDependencies, fakeDeposits } from './__fixtures__/deposits.js'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { fakeAcademy } from './__fixtures__/academy.js'
import { fakeStandingHints } from './__fixtures__/hints.js'
import { fakeWakeup } from './__fixtures__/wakeup.js'
import { fakeAccounts } from './__fixtures__/accounts.js'
import { fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
import { fakeConsole } from './__fixtures__/console.js'
import { fakeContributions } from './__fixtures__/github.js'
import { fakeDomain } from './__fixtures__/domain.js'
import { fakeEmail } from './__fixtures__/email.js'
import { fakeErasureDesk } from './__fixtures__/erasure.js'
import { fakeGithub } from './__fixtures__/github.js'
import { fakeGuidance } from './__fixtures__/guidance.js'
import { fakeImage } from './__fixtures__/image.js'
import { fakeScene } from './__fixtures__/scene.js'
import { fakeInjection } from './__fixtures__/injection.js'
import { fakeVetting } from './__fixtures__/vetting.js'
import { fakeAuthenticator } from './__fixtures__/authenticator.js'
import { fakeKeys } from './__fixtures__/keys.js'
import { fakePow } from './__fixtures__/proof-of-work.js'
import { fakeMemory } from './__fixtures__/memory.js'
import { fakeRegistry } from './__fixtures__/registry.js'
import { fakeAutonomy } from './__fixtures__/autonomy.js'
import { fakeOperatorClaim } from './__fixtures__/operator-claim.js'
import { fakeSocial } from './__fixtures__/social.js'
import { fakeSolana } from './__fixtures__/solana.js'
import { fakeStore } from './__fixtures__/store.js'
import { fakeSubmissions } from './__fixtures__/submissions.js'
import { fakeSupportDesk } from './__fixtures__/support.js'
import { fakeOperatorNotes } from './__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from './__fixtures__/operator-requests.js'
import { fakePermissionReports } from './__fixtures__/permission-reports.js'
import { fakeRotation } from './__fixtures__/rotation.js'
import { fakeVault } from './__fixtures__/vault.js'
import { fakeVision } from './__fixtures__/vision.js'
import { fakeWebServer } from './__fixtures__/web-server.js'
import { fakeWebsite } from './__fixtures__/website.js'
import { erasure } from './erasure.js'
import { support } from './support.js'
import { signInAddressLimiter, signInClientLimiter, SIGN_IN_ADDRESS_LIMIT } from './rate-limit.js'

/**
 * Browser sign-in, from the API's side (`#172`).
 *
 * What the database does with a spent token is `packages/db`'s question and is
 * answered there against a real Postgres. These tests are about the two
 * properties that live at this boundary and nowhere else: what a caller is
 * allowed to *learn*, and what never appears in a response.
 */
describe('the console front door', () => {
  let app: FastifyInstance
  let consoleDeps: ReturnType<typeof fakeConsole>
  let store: ReturnType<typeof fakeStore>

  const build = (overrides: Partial<ReturnType<typeof fakeConsole>> = {}) => {
    consoleDeps = fakeConsole(overrides)
    store = fakeStore()

    return buildApp({
      registry: fakeRegistry(),
      store,
      catalogue: fakeCatalogue(),
      quests: fakeQuests(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      // The operator channel (#236), which this test does not exercise.
      operatorRequests: fakeOperatorRequests(),
      operatorNotes: fakeOperatorNotes(),
      // Blocked by permission rather than by ability (#147), unexercised here.
      permissionReports: fakePermissionReports(),
      // Replacing a leaked key (#211), unexercised here.
      rotation: fakeRotation(),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      email: fakeEmail(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      memory: fakeMemory(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      hints: fakeStandingHints(),
      website: fakeWebsite(),
      webServer: fakeWebServer(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
      vetting: fakeVetting(),
      authenticator: fakeAuthenticator(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      autonomy: fakeAutonomy(),
      domain: fakeDomain(),
      artefact: fakeArtefactChallenges(),
      vision: fakeVision(),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: consoleDeps,
    })
  }

  beforeEach(async () => {
    app = build()
    await app.ready()
  })

  const requestLink = (email: string) =>
    app.inject({ method: 'POST', url: '/v1/console/sign-in', payload: { email } })

  describe('what a caller can learn', () => {
    it('answers a known and an unknown address identically', async () => {
      consoleDeps.store.hold('known@example.org')

      const known = await requestLink('known@example.org')
      const unknown = await requestLink('nobody@example.org')

      expect(known.statusCode).toBe(unknown.statusCode)
      expect(known.body).toBe(unknown.body)
    })

    it('sends mail only for the address somebody holds', async () => {
      consoleDeps.store.hold('known@example.org')

      await requestLink('nobody@example.org')
      expect(consoleDeps.mailer.sent()).toHaveLength(0)

      await requestLink('known@example.org')
      expect(consoleDeps.mailer.sent()).toHaveLength(1)
    })

    it('answers a taken and a fresh sign-up address identically', async () => {
      consoleDeps.store.hold('taken@example.org')

      const taken = await app.inject({
        method: 'POST',
        url: '/v1/console/sign-up',
        payload: { name: 'first-try', email: 'taken@example.org' },
      })
      const fresh = await app.inject({
        method: 'POST',
        url: '/v1/console/sign-up',
        payload: { name: 'second-try', email: 'fresh@example.org' },
      })

      expect(taken.statusCode).toBe(fresh.statusCode)
      expect(taken.body).toBe(fresh.body)
    })

    /**
     * The asymmetry is deliberate: names are already public through
     * `POST /v1/agents/name-check`, and a sign-up that failed silently on one
     * would leave somebody waiting for mail that is never coming.
     */
    it('does say when a name is taken', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/console/sign-up',
        payload: { name: 'sponsor', email: 'one@example.org' },
      })

      const second = await app.inject({
        method: 'POST',
        url: '/v1/console/sign-up',
        payload: { name: 'sponsor', email: 'two@example.org' },
      })

      expect(second.statusCode).toBe(409)
    })

    it('refuses every bad link the same way', async () => {
      const redeem = (token: string) =>
        app.inject({ method: 'POST', url: '/v1/console/sign-in/redeem', payload: { token } })

      const never = await redeem('never-minted')
      const alsoNever = await redeem('also-never-minted')

      expect(never.statusCode).toBe(401)
      expect(never.body).toBe(alsoNever.body)
    })
  })

  describe('where the mail goes', () => {
    /**
     * The property this endpoint exists to preserve. An endpoint that mails the
     * address in the request is an account-takeover primitive, and in the
     * ordinary case the two strings are equal — which is exactly what would make
     * the bug invisible.
     */
    it('addresses the stored mailbox and not the one in the request', async () => {
      consoleDeps.store.hold('canonical@example.org')

      // Plus-addressing: a different string, the same mailbox. The fake resolves
      // it, and what must be mailed is what was stored.
      await requestLink('canonical@example.org')

      expect(consoleDeps.mailer.sent()[0]?.to).toBe('canonical@example.org')
    })

    it('puts the link in the mail and nothing else anywhere', async () => {
      consoleDeps.store.hold('mailed@example.org')

      const response = await requestLink('mailed@example.org')
      const token = consoleDeps.store.tokens()[0]

      expect(token).toBeDefined()
      expect(consoleDeps.mailer.sent()[0]?.text).toContain(token as string)
      expect(response.body).not.toContain(token as string)
    })
  })

  describe('what never appears in a response', () => {
    it('carries no token, hash or session value in any body or header', async () => {
      consoleDeps.store.hold('quiet@example.org')

      const requested = await requestLink('quiet@example.org')
      const token = consoleDeps.store.tokens()[0] as string

      const redeemed = await app.inject({
        method: 'POST',
        url: '/v1/console/sign-in/redeem',
        payload: { token },
      })

      // The token is in the mail and in the request that spends it, and in no
      // response. The session is in `Set-Cookie` and in no body.
      expect(requested.body).not.toContain(token)
      expect(redeemed.body).not.toContain(token)

      const cookie = redeemed.headers['set-cookie']
      const session = String(cookie).split('=')[1]?.split(';')[0] as string
      expect(session.length).toBeGreaterThan(0)
      expect(redeemed.body).not.toContain(session)
    })

    it('sets a cookie that is Secure, HttpOnly, SameSite=Lax and absolutely bounded', async () => {
      consoleDeps.store.hold('cookied@example.org')
      await requestLink('cookied@example.org')

      const redeemed = await app.inject({
        method: 'POST',
        url: '/v1/console/sign-in/redeem',
        payload: { token: consoleDeps.store.tokens()[0] as string },
      })

      const cookie = String(redeemed.headers['set-cookie'])

      expect(cookie).toContain('Secure')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toMatch(/Max-Age=\d+/)
      // The `__Host-` prefix is what makes the cookie unsettable by a sibling host.
      expect(cookie.startsWith('__Host-')).toBe(true)
      expect(cookie).not.toContain('Domain=')
    })
  })

  describe('rate limits', () => {
    it('stops one address asking for links without bound', async () => {
      consoleDeps.store.hold('noisy@example.org')

      for (let i = 0; i < SIGN_IN_ADDRESS_LIMIT; i += 1) {
        expect((await requestLink('noisy@example.org')).statusCode).toBe(202)
      }

      expect((await requestLink('noisy@example.org')).statusCode).toBe(429)
    })

    it('counts two spellings of one mailbox against one allowance', async () => {
      consoleDeps.store.hold('folded@example.org')

      for (let i = 0; i < SIGN_IN_ADDRESS_LIMIT; i += 1) {
        await requestLink('folded@example.org')
      }

      expect((await requestLink('FOLDED@Example.ORG')).statusCode).toBe(429)
    })
  })

  describe('when the Colony cannot send mail', () => {
    it('refuses rather than minting a link nobody could receive', async () => {
      app = build({
        mailer: undefined,
        addressLimiter: signInAddressLimiter(),
        clientLimiter: signInClientLimiter(),
      })
      await app.ready()

      const response = await requestLink('anybody@example.org')

      expect(response.statusCode).toBe(500)
      expect(consoleDeps.store.tokens()).toHaveLength(0)
    })
  })

  describe('a session and a key are the same identity', () => {
    /**
     * The acceptance criterion `#172` states as *"one code path"*. Driven
     * against `GET /v1/agents/me`, which is the route every surface uses to ask
     * who is speaking.
     */
    it('answers the same route identically for both', async () => {
      const issued = store.issue({})
      store.signIn(issued.agent.id, 'a-live-session')

      const byKey = await app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: { authorization: `Bearer ${issued.apiKey}` },
      })

      const bySession = await app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: { cookie: '__Host-kolonie_session=a-live-session' },
      })

      expect(bySession.statusCode).toBe(byKey.statusCode)
      expect(bySession.json()).toEqual(byKey.json())
    })

    it('refuses a cookie naming no session, exactly as it refuses a bad key', async () => {
      const bySession = await app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: { cookie: '__Host-kolonie_session=not-a-session' },
      })

      const byKey = await app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: { authorization: 'Bearer kol_not-a-key' },
      })

      expect(bySession.statusCode).toBe(byKey.statusCode)
      expect(bySession.body).toBe(byKey.body)
    })

    /**
     * A cookie a browser attached must not be able to change the answer to a
     * call that presented a key. The key decides, and the cookie is read only
     * when nothing else was offered.
     */
    it('lets the key decide when both are presented', async () => {
      const issued = store.issue({})
      const other = store.issue({})
      store.signIn(other.agent.id, 'someone-elses-session')

      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: {
          authorization: `Bearer ${issued.apiKey}`,
          cookie: '__Host-kolonie_session=someone-elses-session',
        },
      })

      expect(response.json().agent.id).toBe(issued.agent.id)
    })
  })
})
