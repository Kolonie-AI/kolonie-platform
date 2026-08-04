import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeDepositDependencies, fakeDeposits } from './__fixtures__/deposits.js'
import type { FastifyInstance } from 'fastify'
import type { InjectOptions, Response as InjectResponse } from 'light-my-request'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from './app.js'
import { fakeRegistry } from './__fixtures__/registry.js'
import { fakeStandingHints } from './__fixtures__/hints.js'
import { fakeWakeup } from './__fixtures__/wakeup.js'
import { fakeSolana } from './__fixtures__/solana.js'
import { fakeKeys } from './__fixtures__/keys.js'
import { fakeVision } from './__fixtures__/vision.js'
import { fakePow } from './__fixtures__/proof-of-work.js'
import { fakeMemory } from './__fixtures__/memory.js'
import { fakeContributions, fakeGithub } from './__fixtures__/github.js'
import { fakeAutonomy } from './__fixtures__/autonomy.js'
import { fakeOperatorClaim } from './__fixtures__/operator-claim.js'
import { fakeSocial } from './__fixtures__/social.js'
import { fakeDomain } from './__fixtures__/domain.js'
import { fakeWebServer } from './__fixtures__/web-server.js'
import { fakeWebsite } from './__fixtures__/website.js'
import { fakeImage } from './__fixtures__/image.js'
import { fakeScene } from './__fixtures__/scene.js'
import { fakeInjection } from './__fixtures__/injection.js'
import { fakeVetting } from './__fixtures__/vetting.js'
import { fakeStore, type FakeStore } from './__fixtures__/store.js'
import { fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
import { fakeSubmissions } from './__fixtures__/submissions.js'
import { fakeGuidance } from './__fixtures__/guidance.js'
import { fakeSupportDesk } from './__fixtures__/support.js'
import { fakeOperatorNotes } from './__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from './__fixtures__/operator-requests.js'
import { fakePermissionReports } from './__fixtures__/permission-reports.js'
import { fakeRotation } from './__fixtures__/rotation.js'
import { fakeErasureDesk } from './__fixtures__/erasure.js'
import { erasure } from './erasure.js'
import { support } from './support.js'
import { fakeAcademy } from './__fixtures__/academy.js'
import { fakeVault } from './__fixtures__/vault.js'
import { fakeAccounts } from './__fixtures__/accounts.js'
import { fakeConsole } from './__fixtures__/console.js'
import {
  fakeEmail,
  fakeEmailChallenges,
  fakeMailer,
  FAKE_CHALLENGE_DOMAIN,
  FAKE_INBOUND_SECRET,
  type FakeEmailChallenges,
  type FakeMailer,
} from './__fixtures__/email.js'

let app: FastifyInstance
let store: FakeStore
let challenges: FakeEmailChallenges
let mailer: FakeMailer
let apiKey: string
let agentId: AgentId

/**
 * `inboundSecret` is a required parameter with no default, deliberately.
 *
 * It was optional, and the test below that asserts the route is absent without a
 * secret called `build(undefined)` — which triggers the default and rebuilds the
 * app *with* the secret. The assertion passed nothing and would have gone on
 * passing nothing while the fail-closed property rotted.
 */
const build = (inboundSecret: string | undefined) => {
  store = fakeStore()
  challenges = fakeEmailChallenges()
  mailer = fakeMailer()
  return buildApp({
    quests: fakeQuests(),
    deposits: fakeDepositDependencies(fakeDeposits()),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
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
    website: fakeWebsite(),
    webServer: fakeWebServer(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    email: { ...fakeEmail(challenges, mailer), inboundSecret },
  })
}

beforeEach(async () => {
  app = build(FAKE_INBOUND_SECRET)
  await app.ready()
  const issued = store.issue()
  apiKey = String(issued.apiKey)
  agentId = issued.agent.id
})

afterEach(async () => {
  await app.close()
})

const post = (options: InjectOptions): Promise<InjectResponse> => app.inject(options)

const authed = (url: string, payload: Record<string, unknown>) =>
  post({ method: 'POST', url, payload, headers: { authorization: `Bearer ${apiKey}` } })

const open = (email: string) => authed('/v1/academy/email/challenges', { email })
const handBack = (code: string) => authed('/v1/academy/email/code', { code })
const openBadge = () => authed('/v1/academy/email/send-challenges', {})

const deliver = (to: string, from: string, secret = FAKE_INBOUND_SECRET) =>
  post({
    method: 'POST',
    url: '/v1/internal/email-inbound',
    payload: { from, to },
    headers: { 'x-kolonie-inbound-secret': secret },
  })

/**
 * The whole granting node over HTTP, exactly as an agent would climb it.
 *
 * **Nothing is sent by the agent.** The Colony mails the code when the challenge
 * is opened, and the test reads it where the agent would — out of what the
 * Colony sent, not out of an HTTP response, because serving the code over the
 * API would make the mailbox beside the point.
 */
const climb = async (address: string) => {
  const opened = await open(address)
  const code = String(mailer.sent.at(-1)?.text ?? '').match(/\b[0-9A-F]{12}\b/)?.[0] ?? ''
  return { opened, code, handedBack: await handBack(code) }
}

describe('POST /v1/academy/email/challenges', () => {
  it('mails the code to the address the agent named', async () => {
    const response = await open('citizen@example.org')

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ mailedTo: 'citizen@example.org', mailSent: true })
    expect(response.json().expiresAt).toBeTruthy()
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe('citizen@example.org')
    expect(mailer.sent[0]?.text).toMatch(/\b[0-9A-F]{12}\b/)
  })

  /**
   * **The load-bearing bound** (`kolonie-docs#92`). The Colony now writes to an
   * address the agent chose, so the number of mails has to follow the number of
   * citizens rather than the number of requests — otherwise the Academy is an
   * outbound mailer pointed at addresses somebody else picked, and the first
   * thing that costs is the sending domain every future citizen is reached
   * through.
   */
  it('sends no second mail while a challenge is open', async () => {
    await open('citizen@example.org')
    const again = await open('citizen@example.org')

    expect(again.statusCode).toBe(201)
    expect(again.json()).toMatchObject({ mailSent: false })
    expect(mailer.sent).toHaveLength(1)
  })

  /**
   * The exception, and why `sent_at` exists. A delivery that failed left the
   * citizen holding a challenge it cannot replace; refusing to retry would be a
   * rung it can never pass.
   */
  it('retries a delivery that failed, without minting a second challenge', async () => {
    mailer.breakIt()
    const failed = await open('citizen@example.org')
    expect(failed.statusCode).toBe(500)
    expect(mailer.sent).toHaveLength(0)

    mailer.fixIt()
    const retried = await open('citizen@example.org')

    expect(retried.statusCode).toBe(201)
    expect(retried.json()).toMatchObject({ mailSent: true })
    expect(mailer.sent).toHaveLength(1)
  })

  it('refuses past the lifetime cap and says which number was reached', async () => {
    for (let index = 0; index < 5; index += 1) {
      await open(`try-${index}@example.org`)
      challenges.expire(agentId)
    }

    const refused = await open('one-more@example.org')

    expect(refused.statusCode).toBe(409)
    expect(String(refused.json().message)).toContain('5')
  })

  it('refuses an anonymous caller', async () => {
    const response = await post({
      method: 'POST',
      url: '/v1/academy/email/challenges',
      payload: { email: 'citizen@example.org' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses something that is not an address', async () => {
    const response = await open('not-an-address')

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('validation_failed')
  })

  /**
   * A newline in a claimed address would end up in the reply the Worker
   * composes, which is a header injection one hop away.
   */
  it('refuses an address containing a newline', async () => {
    const response = await open('citizen@example.org\nBcc: victim@example.net')

    expect(response.statusCode).toBe(422)
  })

  it('refuses an address another citizen has proved', async () => {
    challenges.claimForAnother('taken@example.org')

    const response = await open('taken@example.org')

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('conflict')
  })

  /**
   * **A second request naming a different mailbox is refused, not redirected**
   * (`#157`).
   *
   * One open challenge per citizen is the bound and it is unchanged. What this
   * pins is that the request is not answered by mailing the *open* challenge's
   * code to the *newly named* address: redemption credits the address on the
   * row, so a citizen would prove control of one mailbox and be recorded as
   * holding another.
   */
  it('refuses a second address while a challenge is open, and names the first', async () => {
    await open('citizen@example.org')

    const response = await open('elsewhere@example.org')

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('conflict')
    // Both addresses, so the agent can act on the refusal rather than guess.
    expect(String(response.json().message)).toContain('citizen@example.org')
    expect(String(response.json().message)).toContain('elsewhere@example.org')
    // The point of the refusal: nothing went to the address that was not proved.
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe('citizen@example.org')
  })

  /**
   * The same comparison the uniqueness index makes. A citizen asking again with
   * the address it already gave — differently cased, or `+tagged` by whatever
   * composed the request — is asking about the same mailbox and gets its own
   * challenge back.
   */
  it('treats a +tagged repeat of the open address as the same mailbox', async () => {
    await open('citizen@example.org')

    const again = await open('Citizen+kolonie@example.org')

    expect(again.statusCode).toBe(201)
    expect(again.json()).toMatchObject({ mailSent: false })
    expect(mailer.sent).toHaveLength(1)
  })
})

describe('the inbound handler', () => {
  /**
   * **Inbound mail belongs to the badge now** (`kolonie-docs#92`). The granting
   * node no longer asks an agent to send anything, so every test here goes
   * through `email-send` — which first requires the mailbox to have been earned,
   * because the badge reads its address from that grant and never from a payload
   * (D-018).
   */
  const earnThenOpenBadge = async (address = 'citizen@example.org') => {
    await climb(address)
    const badge = await openBadge()
    return String(badge.json().address)
  }

  it('records the mail and passes the badge, when the sender matches', async () => {
    const badgeAddress = await earnThenOpenBadge()
    const response = await deliver(badgeAddress, 'citizen@example.org')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ delivered: true })
  })

  /** **Nothing is mailed back.** The arrival is the verdict. */
  it('sends no reply, because the arrival is the whole proof', async () => {
    const badgeAddress = await earnThenOpenBadge()
    const before = mailer.sent.length

    await deliver(badgeAddress, 'citizen@example.org')

    expect(mailer.sent).toHaveLength(before)
  })

  /**
   * The whole point of reading the address from the grant. A mail claiming to be
   * from the granted address, sent by somebody else, must not pass the badge.
   */
  it('does not accept mail from an address other than the one in the grant', async () => {
    const badgeAddress = await earnThenOpenBadge()
    const response = await deliver(badgeAddress, 'attacker@example.net')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      delivered: false,
      reason: 'sender is not the granted address',
    })
  })

  it('sends nothing for a token it never minted', async () => {
    const response = await deliver(`deadbeef@${FAKE_CHALLENGE_DOMAIN}`, 'citizen@example.org')

    expect(response.json()).toEqual({ delivered: false, reason: 'unknown token' })
    expect(mailer.sent).toHaveLength(0)
  })

  /**
   * The two nodes never satisfy each other, the same discipline
   * `browser_challenges.kind` holds one rung over. A granting challenge's token
   * is not an address anybody was asked to write to.
   */
  it('does not let mail to a granting challenge pass anything', async () => {
    await open('citizen@example.org')

    const response = await deliver(
      `deadbeefdeadbeefde@${FAKE_CHALLENGE_DOMAIN}`,
      'citizen@example.org',
    )

    expect(response.json()).toEqual({ delivered: false, reason: 'unknown token' })
  })

  /** A plus-tag added by a forwarder must not hide the token. */
  it('finds the token behind a plus-tag', async () => {
    const badgeAddress = await earnThenOpenBadge()
    const token = badgeAddress.split('@')[0]

    const response = await deliver(
      `${token}+forwarded@${FAKE_CHALLENGE_DOMAIN}`,
      'citizen@example.org',
    )

    expect(response.json()).toEqual({ delivered: true })
  })

  it('counts a redelivered message once', async () => {
    const badgeAddress = await earnThenOpenBadge()

    expect((await deliver(badgeAddress, 'citizen@example.org')).json()).toEqual({ delivered: true })
    expect((await deliver(badgeAddress, 'citizen@example.org')).json()).toEqual({ delivered: true })
  })

  it('refuses a caller that does not hold the secret', async () => {
    const opened = await open('citizen@example.org')
    const response = await deliver(opened.json().address, 'citizen@example.org', 'wrong-secret')

    expect(response.statusCode).toBe(401)
  })

  it('refuses a caller presenting no secret at all', async () => {
    const opened = await open('citizen@example.org')
    const response = await post({
      method: 'POST',
      url: '/v1/internal/email-inbound',
      payload: { from: 'citizen@example.org', to: opened.json().address },
    })

    expect(response.statusCode).toBe(401)
  })

  /**
   * Fails closed, and the whole route is absent rather than open. This endpoint
   * turns "a mail arrived" into a fact the Colony pays a reward for.
   */
  it('is not mounted at all when no secret is configured', async () => {
    await app.close()
    app = build(undefined)
    await app.ready()
    const issued = store.issue()
    apiKey = String(issued.apiKey)
    agentId = issued.agent.id

    const opened = await open('citizen@example.org')
    const response = await post({
      method: 'POST',
      url: '/v1/internal/email-inbound',
      payload: { from: 'citizen@example.org', to: opened.json().address },
      headers: { 'x-kolonie-inbound-secret': FAKE_INBOUND_SECRET },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * There is no `retry: true` branch left here, and that is a real
   * simplification rather than an omission (`kolonie-docs#92`).
   *
   * It existed because the inbound handler used to *send* — it replied to the
   * arriving mail with the code, so the Colony's own mailer sitting in that path
   * could fail after the agent had done everything right. The badge sends
   * nothing, so the only work this route does now is write a row, and there is
   * no vendor left in it to be down.
   */
  it('never asks for redelivery, because it no longer sends anything', async () => {
    const badgeAddress = await earnThenOpenBadge()
    mailer.breakIt()

    const response = await deliver(badgeAddress, 'citizen@example.org')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ delivered: true })
  })

  it('answers 200 when it decided to do nothing, so nothing is redelivered', async () => {
    const response = await deliver(`deadbeef@${FAKE_CHALLENGE_DOMAIN}`, 'someone@example.net')

    expect(response.statusCode).toBe(200)
  })
})

describe('POST /v1/academy/email/code', () => {
  it('closes the proof', async () => {
    const { handedBack } = await climb('citizen@example.org')

    expect(handedBack.statusCode).toBe(200)
    expect(handedBack.json()).toEqual({ verified: true, address: 'citizen@example.org' })
  })

  it('refuses an anonymous caller', async () => {
    const response = await post({
      method: 'POST',
      url: '/v1/academy/email/code',
      payload: { code: 'ABCDEF123456' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses a wrong code', async () => {
    const opened = await open('citizen@example.org')
    await deliver(opened.json().address, 'citizen@example.org')

    const response = await handBack('AAAAAAAAAAAA')

    expect(response.statusCode).toBe(422)
  })

  /**
   * The distinction that decides the agent's next move: ask again so the
   * delivery is retried, or read the mail more carefully. Collapsing the two
   * into one failure is how an agent spends an hour on the wrong problem.
   */
  it('says the code was never delivered rather than that it is wrong', async () => {
    mailer.breakIt()
    await open('citizen@example.org')

    const response = await handBack('AAAAAAAAAAAA')

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('never managed to deliver')
  })

  it('says the code is wrong once one has actually gone out', async () => {
    await open('citizen@example.org')

    const response = await handBack('AAAAAAAAAAAA')

    expect(response.statusCode).toBe(422)
  })

  it('tells an agent with no challenge to open one', async () => {
    const response = await handBack('AAAAAAAAAAAA')

    expect(response.statusCode).toBe(404)
  })

  it('reports an expired challenge as expired, not as a wrong code', async () => {
    const opened = await open('citizen@example.org')
    await deliver(opened.json().address, 'citizen@example.org')
    challenges.expire(agentId)

    const response = await handBack('AAAAAAAAAAAA')

    expect(response.statusCode).toBe(410)
    expect(response.json().code).toBe('task_expired')
  })
})

/**
 * The two bounds, over HTTP (`#153`).
 *
 * What the route has to get right is not the arithmetic — that is asserted
 * against a real database in `packages/db` — but that the two refusals reach the
 * agent as *different situations*. One is waited out and the other is not.
 */
describe('what bounds how often the Colony will write', () => {
  const spendWindow = async () => {
    for (let index = 0; index < 5; index += 1) {
      await open(`try-${index}@example.org`)
      challenges.expire(agentId)
    }
  }

  it('refuses at the window and says when to ask again', async () => {
    await spendWindow()

    const refused = await open('one-more@example.org')

    expect(refused.statusCode).toBe(409)
    expect(refused.json().message).toContain('Ask again after')
    // Machine-readable beside the prose, so an agent does not have to parse a
    // sentence to learn when to come back.
    expect(Date.parse(String(refused.json().details?.retryAfter))).toBeGreaterThan(Date.now())
  })

  it('lets the citizen through once the window has passed', async () => {
    await spendWindow()
    expect((await open('one-more@example.org')).statusCode).toBe(409)

    challenges.ageOutOfWindow(agentId)

    expect((await open('one-more@example.org')).statusCode).toBe(201)
  })

  /**
   * The recoverable refusal must not read like the permanent one. An agent told
   * to open a support ticket when all it had to do was wait has been sent to the
   * wrong place, and it is the more common of the two.
   */
  it('does not tell a citizen at the window to open a support ticket', async () => {
    await spendWindow()

    expect((await open('one-more@example.org')).json().message).not.toContain('support')
  })
})

/**
 * The citizen's own mailbox record, and the move that keeps it usable (`#149`).
 *
 * D-047 made the first proved address permanent — which fixed the badge's moving
 * subject and, with no promotion reachable from anywhere, left a citizen that
 * lost that mailbox reachable for ever at an address it cannot read.
 */
describe('GET /v1/mailboxes', () => {
  it('names what the citizen proved and which address the Colony writes to', async () => {
    await climb('first@example.org')
    challenges.proveDirectly(agentId, 'second@example.org')

    const response = await post({
      method: 'GET',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${apiKey}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().mailboxes).toEqual([
      expect.objectContaining({ address: 'first@example.org', reach: true }),
      expect.objectContaining({ address: 'second@example.org', reach: false }),
    ])
  })

  /** Served rather than only written into a task text that cannot change with it. */
  it('reports the limits and what has been spent against them', async () => {
    await open('citizen@example.org')

    const response = await post({
      method: 'GET',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${apiKey}` },
    })

    expect(response.json().limits).toMatchObject({ openedInWindow: 1, openedEver: 1 })
    expect(response.json().limits.windowCap).toBeGreaterThan(0)
    expect(response.json().limits.ceiling).toBeGreaterThan(response.json().limits.windowCap)
  })

  it('refuses an anonymous caller', async () => {
    const response = await post({ method: 'GET', url: '/v1/mailboxes' })

    expect(response.statusCode).toBe(401)
  })

  /**
   * **Not gated on the mailer**, unlike every rung route in this file. A citizen
   * that cannot read the address the Colony writes to is exactly the citizen that
   * needs this during a mail outage.
   */
  it('answers even when the Colony cannot send mail', async () => {
    const withoutMailer = buildApp({
      quests: fakeQuests(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: fakeConsole(),
      registry: fakeRegistry(),
      store,
      catalogue: fakeCatalogue(),
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
      website: fakeWebsite(),
      webServer: fakeWebServer(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
      vetting: fakeVetting(),
      email: { ...fakeEmail(challenges), mailer: undefined, inboundSecret: FAKE_INBOUND_SECRET },
    })
    await withoutMailer.ready()

    const response = await withoutMailer.inject({
      method: 'GET',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${apiKey}` },
    })

    expect(response.statusCode).toBe(200)
    await withoutMailer.close()
  })
})

describe('POST /v1/mailboxes/promote', () => {
  const promote = (email: string) => authed('/v1/mailboxes/promote', { email })

  it('moves the address the Colony writes to', async () => {
    await climb('first@example.org')
    challenges.proveDirectly(agentId, 'second@example.org')

    const response = await promote('second@example.org')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      address: 'second@example.org',
      moved: true,
      sendChallengeClosed: false,
    })
    expect(await challenges.proved(agentId)).toMatchObject({ address: 'second@example.org' })
  })

  /**
   * The whole of `#287`, walked the way the citizen who reported it walked it:
   * open the badge challenge, prove a second mailbox, promote it, and try to
   * pass the badge from the address the Colony now says it reaches you at.
   *
   * Before the fix the challenge stayed open against the old address while the
   * response named the new one, so the citizen was told to send from an address
   * the verifier would reject — and did, twice.
   */
  it('closes an open badge challenge, so the badge can be passed from the new address', async () => {
    await climb('first@example.org')
    const stale = String((await openBadge()).json().address)
    challenges.proveDirectly(agentId, 'second@example.org')

    const promoted = await promote('second@example.org')
    expect(promoted.json()).toMatchObject({ moved: true, sendChallengeClosed: true })

    // The old challenge is closed, so mail to it no longer counts for anything.
    expect((await deliver(stale, 'first@example.org')).json()).toEqual({
      delivered: false,
      reason: 'challenge expired',
    })

    // And the fresh one names the address that is now the reach address, which
    // is both what the response says and what the arrival is checked against.
    const fresh = await openBadge()
    expect(fresh.json()).toMatchObject({ from: 'second@example.org' })
    expect((await deliver(String(fresh.json().address), 'second@example.org')).json()).toEqual({
      delivered: true,
    })
  })

  /**
   * The rejection case: an address this citizen never proved cannot become the
   * one the Colony writes to. Otherwise the reach address would be an assertion
   * rather than a proof, which is the whole point of the rung underneath it.
   */
  it('refuses an address the citizen has not proved', async () => {
    await climb('first@example.org')

    const response = await promote('never-proved@example.org')

    expect(response.statusCode).toBe(404)
    expect(response.json().message).toContain('have not proved')
  })

  /**
   * `already_primary` must not flatten into a failure: a citizen asking for the
   * state it already has wanted that state, and a retry after a dropped
   * connection would otherwise look like a refusal.
   */
  it('succeeds when the address is already the one the Colony writes to', async () => {
    await climb('first@example.org')

    const response = await promote('first@example.org')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      address: 'first@example.org',
      moved: false,
      sendChallengeClosed: false,
    })
  })

  it('refuses an anonymous caller', async () => {
    const response = await post({
      method: 'POST',
      url: '/v1/mailboxes/promote',
      payload: { email: 'first@example.org' },
    })

    expect(response.statusCode).toBe(401)
  })

  /** No agent id in the payload, on either operation: the subject is the key holder. */
  it('never lets a caller name another citizen', async () => {
    await climb('first@example.org')
    const other = store.issue()
    challenges.proveDirectly(other.agent.id, 'theirs@example.org')

    const response = await promote('theirs@example.org')

    expect(response.statusCode).toBe(404)
  })
})
