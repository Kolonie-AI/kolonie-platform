import { API_BASE_PATH, DEFAULT_RHYTHM_BOUNDS } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { fakeAcademy } from '../../../__fixtures__/academy.js'
import { fakeAccounts } from '../../../__fixtures__/accounts.js'
import { fakeCatalogue } from '../../../__fixtures__/catalogue.js'
import { FAKE_CALLER_IP } from '../../../__fixtures__/colony.js'
import { fakeDomain } from '../../../__fixtures__/domain.js'
import {
  FAKE_INBOUND_SECRET,
  fakeEmail,
  fakeEmailChallenges,
  fakeMailer,
} from '../../../__fixtures__/email.js'
import { fakeErasureDesk } from '../../../__fixtures__/erasure.js'
import { fakeContributions, fakeGithub } from '../../../__fixtures__/github.js'
import { fakeGuidance } from '../../../__fixtures__/guidance.js'
import { fakeImage } from '../../../__fixtures__/image.js'
import { fakeKeys } from '../../../__fixtures__/keys.js'
import { anonymousClient, connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'
import { fakePow } from '../../../__fixtures__/proof-of-work.js'
import { fakeRegistry } from '../../../__fixtures__/registry.js'
import { fakeSocial } from '../../../__fixtures__/social.js'
import { fakeSolana } from '../../../__fixtures__/solana.js'
import { fakeStore } from '../../../__fixtures__/store.js'
import { fakeSubmissions } from '../../../__fixtures__/submissions.js'
import { fakeSupportDesk } from '../../../__fixtures__/support.js'
import { fakeVault } from '../../../__fixtures__/vault.js'
import { fakeVision } from '../../../__fixtures__/vision.js'
import { fakeWebsite } from '../../../__fixtures__/website.js'
import { buildApp } from '../../../app.js'
import { erasure } from '../../../erasure.js'
import { support } from '../../../support.js'

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
describe('kolonie.academy.email.challenge and .code', () => {
  const CLAIMED = 'citizen@example.org'

  /** One store, one set of email challenges, one mailer — behind both doors. */
  const bothDoors = async () => {
    const store = fakeStore()
    const mailer = fakeMailer()
    const challenges = fakeEmailChallenges()
    const email = fakeEmail(challenges, mailer)
    const app = buildApp({
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      email,
      registry: fakeRegistry(),
      store,
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
    })
    await app.ready()

    const { apiKey, agent } = store.issue({})
    const { client, close } = await connectedClient(
      {
        vault: { vault: fakeVault() },
        accounts: fakeAccounts(),
        rhythm: DEFAULT_RHYTHM_BOUNDS,
        registry: fakeRegistry(),
        store,
        catalogue: fakeCatalogue(),
        submissions: fakeSubmissions(),
        guidance: fakeGuidance(),
        support: support({ desk: fakeSupportDesk() }),
        erasure: erasure({ desk: fakeErasureDesk() }),
        retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
        academy: fakeAcademy(),
        email,
        keys: fakeKeys(),
        solana: fakeSolana(),
        pow: fakePow(),
        vision: fakeVision(),
        github: fakeGithub(),
        contributions: fakeContributions(),
        social: fakeSocial(),
        domain: fakeDomain(),
        website: fakeWebsite(),
        image: fakeImage(),
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
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    const closed = await client.callTool({
      name: 'kolonie.academy.email.code',
      arguments: { code: codeFromMail() },
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
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
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
      name: 'kolonie.academy.email.code',
      arguments: { code: codeFromMail() },
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
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    const closed = await client.callTool({
      name: 'kolonie.academy.email.code',
      arguments: { code: 'ABCDEF123456' },
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
      { ...colony, email: { ...fakeEmail(), mailer: undefined } },
      `Bearer ${apiKey}`,
    )

    const opened = await client.callTool({
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    const elsewhere = await client.callTool({
      name: 'kolonie.academy.key.challenge',
      arguments: {},
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

    expect(names).not.toContain('kolonie.academy.email.challenge')
    expect(names).not.toContain('kolonie.academy.email.code')
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
        name: 'kolonie.academy.email.challenge',
        arguments: { email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.email.code',
        arguments: { code: codeFromMail() },
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
        name: 'kolonie.academy.email.challenge',
        arguments: { email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.email.code',
        arguments: { code: codeFromMail() },
      })
      challenges.proveDirectly(agentId, 'second@example.org')

      const promoted = await client.callTool({
        name: 'kolonie.mailboxes.promote',
        arguments: { email: 'second@example.org' },
      })

      expect(promoted.isError).toBeFalsy()
      expect(promoted.structuredContent).toEqual({ address: 'second@example.org', moved: true })
      expect(await challenges.proved(agentId)).toMatchObject({ address: 'second@example.org' })
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
        name: 'kolonie.academy.email.challenge',
        arguments: { email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.email.code',
        arguments: { code: codeFromMail() },
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
