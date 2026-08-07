import { fakeHumans } from '../../../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../../../__fixtures__/artefact.js'
import { API_BASE_PATH, DEFAULT_RHYTHM_BOUNDS } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { fakeAcademy } from '../../../__fixtures__/academy.js'
import { fakeProviderRecipes } from '../../../__fixtures__/provider-recipes.js'
import { fakeAccounts } from '../../../__fixtures__/accounts.js'
import { fakeConsole } from '../../../__fixtures__/console.js'
import { fakeCatalogue } from '../../../__fixtures__/catalogue.js'
import { fakeQuests } from '../../../__fixtures__/quests.js'
import { FAKE_CALLER_IP } from '../../../__fixtures__/colony/index.js'
import { fakeDomain } from '../../../__fixtures__/domain.js'
import {
  FAKE_INBOUND_SECRET,
  fakeEmail,
  fakeEmailChallenges,
  fakeMailer,
} from '../../../__fixtures__/email.js'
import { fakeSms } from '../../../__fixtures__/sms.js'
import { fakeErasureDesk } from '../../../__fixtures__/erasure.js'
import { fakeContributions, fakeGithub } from '../../../__fixtures__/github.js'
import { fakeGuidance } from '../../../__fixtures__/guidance.js'
import { fakeImage } from '../../../__fixtures__/image.js'
import { fakeScene } from '../../../__fixtures__/scene.js'
import { fakeInjection } from '../../../__fixtures__/injection.js'
import { fakeVetting } from '../../../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../../../__fixtures__/authenticator.js'
import { fakeKeys } from '../../../__fixtures__/keys.js'
import { anonymousClient, connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'
import { fakePow } from '../../../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../../../__fixtures__/memory.js'
import { fakeRegistry } from '../../../__fixtures__/registry.js'
import { fakeAutonomy } from '../../../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../../../__fixtures__/operator-claim.js'
import { fakeSocial } from '../../../__fixtures__/social.js'
import { fakeSolana } from '../../../__fixtures__/solana.js'
import { fakeStore } from '../../../__fixtures__/store.js'
import { fakeSubmissions } from '../../../__fixtures__/submissions.js'
import { fakeSupportDesk } from '../../../__fixtures__/support.js'
import { fakeOperatorNotes } from '../../../__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from '../../../__fixtures__/operator-requests.js'
import { fakePermissionReports } from '../../../__fixtures__/permission-reports.js'
import { fakeRotation } from '../../../__fixtures__/rotation.js'
import { fakeVault } from '../../../__fixtures__/vault.js'
import { fakeVision } from '../../../__fixtures__/vision.js'
import { fakeReachability } from '../../../__fixtures__/reachability.js'
import { fakeWebServer } from '../../../__fixtures__/web-server.js'
import { fakeWebsite } from '../../../__fixtures__/website.js'
import { fakeStandingHints } from '../../../__fixtures__/hints.js'
import { fakeWakeup } from '../../../__fixtures__/wakeup.js'
import { buildApp } from '../../../app.js'
import { erasure } from '../../../erasure.js'
import { support } from '../../../support.js'
import { DEFAULT_SKILL_RELEASES } from '../../../skill-releases.js'

/**
 * The mailbox rung over MCP (#38).
 *
 * One Colony behind both doors, because the property under test is not that the
 * tools exist but that they cannot disagree with the routes: the rung is a round
 * trip through the mail system, and an agent that opened a challenge on one
 * surface and closed it on the other must not find two different challenges.
 *
 * The inbound step is always HTTP, on every one of these tests, and that is the
 * rung rather than a gap in the coverage: it is a Cloudflare Worker handing over
 * a mail that arrived, not an agent doing anything. What the agent touches is
 * the two tools.
 */
describe('kolonie.academy.answer with kind "email.challenge" and .code', () => {
  const CLAIMED = 'citizen@example.org'

  /** One store, one set of email challenges, one mailer — behind both doors. */
  const bothDoors = async () => {
    const store = fakeStore()
    const mailer = fakeMailer()
    const challenges = fakeEmailChallenges()
    const email = fakeEmail(challenges, mailer)
    const app = buildApp({
      humans: fakeHumans(),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      sms: fakeSms(),
      console: fakeConsole(),
      email,
      registry: fakeRegistry(),
      store,
      catalogue: fakeCatalogue(),
      quests: fakeQuests(),
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
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      memory: fakeMemory(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      hints: fakeStandingHints(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      autonomy: fakeAutonomy(),
      domain: fakeDomain(),
      artefact: fakeArtefactChallenges(),
      website: fakeWebsite(),
      webServer: fakeWebServer(),
      reachability: fakeReachability(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
      vetting: fakeVetting(),
      authenticator: fakeAuthenticator(),
    })
    await app.ready()

    const { apiKey, agent } = store.issue({})
    const { client, close } = await connectedClient(
      {
        vault: { vault: fakeVault() },
        accounts: fakeAccounts(),
        recipes: fakeProviderRecipes(),
        humans: fakeHumans(),
        sms: fakeSms(),
        rhythm: DEFAULT_RHYTHM_BOUNDS,
        skillReleases: DEFAULT_SKILL_RELEASES,
        registry: fakeRegistry(),
        store,
        catalogue: fakeCatalogue(),
        quests: fakeQuests(),
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
        email,
        keys: fakeKeys(),
        solana: fakeSolana(),
        pow: fakePow(),
        memory: fakeMemory(),
        vision: fakeVision(),
        github: fakeGithub(),
        contributions: fakeContributions(),
        wakeup: fakeWakeup(),
        hints: fakeStandingHints(),
        social: fakeSocial(),
        operatorClaim: fakeOperatorClaim(),
        autonomy: fakeAutonomy(),
        domain: fakeDomain(),
        artefact: fakeArtefactChallenges(),
        website: fakeWebsite(),
        webServer: fakeWebServer(),
        reachability: fakeReachability(),
        image: fakeImage(),
        scene: fakeScene(),
        injection: fakeInjection(),
        vetting: fakeVetting(),
        authenticator: fakeAuthenticator(),
        caller: { ip: FAKE_CALLER_IP },
      },
      `Bearer ${apiKey}`,
    )

    /** What the Worker does when a mail reaches the challenge address. */
    const deliver = (to: string, from = CLAIMED) =>
      app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/internal/email-inbound`,
        payload: { from, to },
        headers: { 'x-kolonie-inbound-secret': FAKE_INBOUND_SECRET },
      })

    /** The code where the agent reads it: out of the mail, not out of a response. */
    const codeFromMail = () =>
      String(mailer.sent.at(-1)?.text ?? '').match(/\b[0-9A-F]{12}\b/)?.[0] ?? ''

    return {
      app,
      client,
      apiKey: String(apiKey),
      agentId: agent.id,
      challenges,
      deliver,
      codeFromMail,
      mailer,
      close: async () => {
        await close()
        await app.close()
      },
    }
  }

  it('carries an agent through the whole rung without ever calling /v1', async () => {
    const { client, codeFromMail, close } = await bothDoors()

    const opened = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'email.challenge', email: CLAIMED },
    })
    const closed = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'email.code', code: codeFromMail() },
    })

    expect(opened.isError).toBeFalsy()
    // **Nothing is delivered by the agent anywhere in this test.** The Colony
    // mails the code when the challenge opens, and the whole rung is reading it
    // back — which is what makes a receive-only address enough (kolonie-docs#92).
    expect(opened.structuredContent).toMatchObject({ mailedTo: CLAIMED, mailSent: true })
    expect(closed.isError).toBeFalsy()
    expect(closed.structuredContent).toEqual({ verified: true, address: CLAIMED })
    await close()
  })

  it('opens over MCP and closes over HTTP — one challenge, two doors', async () => {
    const { client, apiKey, app, codeFromMail, close } = await bothDoors()

    await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'email.challenge', email: CLAIMED },
    })
    const closed = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/academy/email/code`,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: { code: codeFromMail() },
    })

    expect(closed.statusCode).toBe(200)
    expect(closed.json()).toEqual({ verified: true, address: CLAIMED })
    await close()
  })

  it('opens over HTTP and closes over MCP — the other way round', async () => {
    const { client, apiKey, app, deliver, codeFromMail, close } = await bothDoors()

    const opened = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/academy/email/challenges`,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: { email: CLAIMED },
    })
    await deliver(opened.json().address)
    const closed = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'email.code', code: codeFromMail() },
    })

    expect(closed.isError).toBeFalsy()
    expect(closed.structuredContent).toEqual({ verified: true, address: CLAIMED })
    await close()
  })

  /**
   * The rejection an agent will actually meet: it opens a challenge, sends the
   * mail, and calls back before delivery. The refusal has to say which half is
   * missing, or the agent cannot tell "wait" from "retry".
   */
  it('refuses a code the Colony never managed to deliver, and says so', async () => {
    const { client, mailer, close } = await bothDoors()

    mailer.breakIt()
    await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'email.challenge', email: CLAIMED },
    })
    const closed = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'email.code', code: 'ABCDEF123456' },
    })

    expect(closed.isError).toBe(true)
    const text = JSON.stringify(closed.content)
    expect(text).toContain('conflict')
    expect(text).toContain('never managed to deliver')
    await close()
  })

  /**
   * The rung degrades to two tools refusing, not to a tier that fails to build.
   * An unconfigured mailer is the Colony's problem, and an agent still holding
   * open branches elsewhere in the graph must keep them.
   */
  it('refuses when the Colony has no way to send the code, and leaves the tier standing', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(
      { ...colony, email: { ...fakeEmail(), mailer: undefined }, sms: fakeSms() },
      `Bearer ${apiKey}`,
    )

    const opened = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'email.challenge', email: CLAIMED },
    })
    const elsewhere = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'key-signature' },
    })

    expect(opened.isError).toBe(true)
    expect(JSON.stringify(opened.content)).toContain('could never be completed')
    expect(elsewhere.isError).toBeFalsy()
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.academy.answer with kind "email.challenge"')
    expect(names).not.toContain('kolonie.academy.answer with kind "email.code"')
    await close()
  })

  /**
   * The mailbox record and the promotion, over MCP (`#149`).
   *
   * `promoteMailbox` and `provedMailboxes` were written with D-047 and reachable
   * from nothing, so the trap that fix was written to prevent — a citizen
   * reachable for ever at an address it cannot read — was live one layer above
   * where the fix landed. These two tools are that layer.
   */
  describe('kolonie.mailboxes.list and .promote', () => {
    it('names what the citizen proved and which one the Colony writes to', async () => {
      const { client, challenges, agentId, codeFromMail, close } = await bothDoors()

      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.challenge', email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.code', code: codeFromMail() },
      })
      challenges.proveDirectly(agentId, 'second@example.org')

      const listed = await client.callTool({ name: 'kolonie.mailboxes.list', arguments: {} })

      expect(listed.isError).toBeFalsy()
      expect(listed.structuredContent).toMatchObject({
        mailboxes: [
          { address: CLAIMED, reach: true },
          { address: 'second@example.org', reach: false },
        ],
      })
      await close()
    })

    it('moves the address the Colony writes to', async () => {
      const { client, challenges, agentId, codeFromMail, close } = await bothDoors()

      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.challenge', email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.code', code: codeFromMail() },
      })
      challenges.proveDirectly(agentId, 'second@example.org')

      const promoted = await client.callTool({
        name: 'kolonie.mailboxes.promote',
        arguments: { email: 'second@example.org' },
      })

      expect(promoted.isError).toBeFalsy()
      expect(promoted.structuredContent).toEqual({
        address: 'second@example.org',
        moved: true,
        sendChallengeClosed: false,
      })
      expect(await challenges.proved(agentId)).toMatchObject({ address: 'second@example.org' })
      await close()
    })

    /**
     * `#287`: closing the stale challenge is right, and doing it silently is
     * not. A citizen that had already sent mail to the old challenge address is
     * owed the reason it will not count, and the remedy is one call it has to
     * know to make.
     */
    it('says so when the move closed an open email-send challenge', async () => {
      const { client, challenges, agentId, codeFromMail, close } = await bothDoors()

      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.challenge', email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.code', code: codeFromMail() },
      })
      await client.callTool({
        name: 'kolonie.academy.challenge',
        arguments: { kind: 'email-send' },
      })
      challenges.proveDirectly(agentId, 'second@example.org')

      const promoted = await client.callTool({
        name: 'kolonie.mailboxes.promote',
        arguments: { email: 'second@example.org' },
      })

      expect(promoted.structuredContent).toMatchObject({ sendChallengeClosed: true })
      expect(JSON.stringify(promoted.content)).toMatch(/kolonie\.academy\.email\.send/)
      await close()
    })

    /**
     * `#307`, the half `#287` could not reach: the close runs inside the
     * promotion, so a challenge minted before that shipped stayed open against
     * the old address for its whole 24 hours. The citizen that reported it was
     * told by `kolonie.me` that the Colony now writes to the promoted mailbox
     * and handed the receive-only one by this call on every ask — a task made
     * impossible until an expiry it could only wait out.
     */
    it('reissues an email-send challenge left open against the old mailbox', async () => {
      const { client, challenges, agentId, codeFromMail, close } = await bothDoors()

      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.challenge', email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.code', code: codeFromMail() },
      })
      const stale = await client.callTool({
        name: 'kolonie.academy.challenge',
        arguments: { kind: 'email-send' },
      })
      challenges.proveDirectly(agentId, 'second@example.org')
      challenges.moveReachSilently(agentId, 'second@example.org')

      const reissued = await client.callTool({
        name: 'kolonie.academy.challenge',
        arguments: { kind: 'email-send' },
      })

      expect(reissued.isError).toBeFalsy()
      expect(reissued.structuredContent).toMatchObject({
        from: 'second@example.org',
        reissued: true,
      })
      expect(reissued.structuredContent).not.toMatchObject({
        address: (stale.structuredContent as { address: string }).address,
      })
      // Told, not silently swapped: the citizen is holding the old address and
      // the old deadline, and both have just stopped being true.
      expect(JSON.stringify(reissued.content)).toMatch(/closed and this one issued in its place/)
      await close()
    })

    /**
     * The half that would make the repair worse than the defect. An ordinary
     * repeat ask must find its own challenge, not reset the deadline and replace
     * the address a citizen has already written mail to.
     */
    it('hands back the same challenge, unreissued, when nothing has moved', async () => {
      const { client, codeFromMail, close } = await bothDoors()

      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.challenge', email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.code', code: codeFromMail() },
      })

      const first = await client.callTool({
        name: 'kolonie.academy.challenge',
        arguments: { kind: 'email-send' },
      })
      const again = await client.callTool({
        name: 'kolonie.academy.challenge',
        arguments: { kind: 'email-send' },
      })

      // The address is the identity of the challenge; the fixture restamps
      // `expiresAt` on every read, which the real store does not.
      expect(again.structuredContent).toMatchObject({
        address: (first.structuredContent as { address: string }).address,
        from: CLAIMED,
        reissued: false,
      })
      expect(JSON.stringify(again.content)).not.toMatch(/issued in its place/)
      await close()
    })

    /**
     * The sentence an agent needs before it dares call this. Without it a citizen
     * assumes a promotion invalidates the badge it earned and never moves an
     * address it can no longer read.
     */
    it('says the email-send badge is neither re-earned nor revoked', async () => {
      const { client, close } = await bothDoors()

      const { tools } = await client.listTools()
      const tool = tools.find((candidate) => candidate.name === 'kolonie.mailboxes.promote')

      expect(tool?.description).toMatch(/does not re-earn or revoke the email-send badge/i)
      await close()
    })

    /** Neither operation takes an agent id: the subject is whoever holds the key. */
    it('never offers a way to name another citizen', async () => {
      const { client, close } = await bothDoors()

      const { tools } = await client.listTools()
      const list = tools.find((candidate) => candidate.name === 'kolonie.mailboxes.list')
      const promote = tools.find((candidate) => candidate.name === 'kolonie.mailboxes.promote')

      expect(Object.keys(list?.inputSchema.properties ?? {})).toEqual([])
      expect(Object.keys(promote?.inputSchema.properties ?? {})).toEqual(['email'])
      await close()
    })

    it('refuses an address the citizen has not proved', async () => {
      const { client, codeFromMail, close } = await bothDoors()

      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.challenge', email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'email.code', code: codeFromMail() },
      })

      const refused = await client.callTool({
        name: 'kolonie.mailboxes.promote',
        arguments: { email: 'never-proved@example.org' },
      })

      expect(refused.isError).toBeTruthy()
      expect(JSON.stringify(refused.content)).toContain('have not proved')
      await close()
    })
  })
})
