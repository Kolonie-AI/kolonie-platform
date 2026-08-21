import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { fakeOperatorPageMessages } from '../__fixtures__/operator-page-message.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * The operator page's second door (`#428`).
 *
 * **What these tests are for is that there is one page and not two.** `#428`
 * argues that two renderings of an operator's view disagree within a month and
 * the one being read is the wrong one, so the load-bearing assertion here is the
 * one that compares the two bodies — not the ones that check the routes answer.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let pages: ReturnType<typeof fakeOperatorPages>
let requests: ReturnType<typeof fakeOperatorThreads>
let agentId: AgentId
let otherAgentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  pages = fakeOperatorPages()
  requests = fakeOperatorThreads({ pages })
  const agents = fakeStore()

  app = buildApp({
    ...fakeColony(),
    store: agents,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
    autonomy: {
      store: fakeAutonomyStore(),
      pages,
      mailer: fakeAutonomyMailer(),
      formBaseUrl: 'https://console.example',
    },
    // The same page store on all three, as production has it: a token is what
    // resolves an exchange and a note, so a second store here would let this
    // file write through a link the revoke path had never heard of.
    operatorThreads: requests,
    operatorPageMessages: fakeOperatorPageMessages({ pages }),
    /**
     * A sealing key is configured (`#1444`). The page's sentence about where a
     * secret goes branches on this, and nothing here shares anything — what is
     * being asserted is the copy, not the channel.
     */
    operatorShares: {
      forPageToken: () => Promise.resolve([]),
      forOperator: () => Promise.resolve([]),
      recordRead: () => Promise.resolve(false),
      write: () => Promise.resolve({ outcome: 'closed' as const }),
      handBack: () => Promise.resolve({ outcome: 'closed' as const }),
    },
  })
  await app.ready()

  agentId = agents.issue().agent.id
  otherAgentId = agents.issue().agent.id
})

afterEach(async () => {
  await app?.close()
})

/** Sign in and keep the cookie. */
const signedInCookie = async (): Promise<string> => {
  const started = await app.inject({
    method: 'GET',
    url: '/sign-in/github',
    headers: { host: CONSOLE_HOST, accept: 'text/html' },
  })
  const state = new URL(started.headers['location'] as string).searchParams.get('state') as string
  const back = await app.inject({
    method: 'GET',
    url: `/sign-in/callback?code=abc&state=${state}`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  })
  const raw = back.headers['set-cookie']
  const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  const cookie = all.find((one) => one.startsWith(`${SESSION_COOKIE}=`)) as string
  return cookie.slice(0, cookie.indexOf(';'))
}

/**
 * Link the person who just signed in to an agent, through the code path `#426`
 * built rather than by writing the join row directly — so these tests authorise
 * against the same table the route reads.
 */
const link = async (id: AgentId): Promise<void> => {
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, human.id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
}

const openDoor = (cookie: string, id: AgentId) =>
  app.inject({
    method: 'GET',
    url: `/agents/${id}/operator`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
  })

describe('the operator page opens on a session', () => {
  /**
   * **The acceptance criterion this issue turns on.** One renderer, two routes —
   * asserted by comparing the bodies rather than by reading both and agreeing
   * they look similar.
   *
   * The two differ in exactly one way and it is the intended one: where the forms
   * post. The token door posts to the token URL and the console door posts to its
   * own path, because `#428` refuses to put a durable bearer link inside a page
   * served behind a login.
   */
  it('renders the identical body the mailed link renders, but for the form action', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const token = await pages.issue(agentId, 'op@example.org')

    const throughToken = await app.inject({ method: 'GET', url: `/operator/page/${token}` })
    const throughSession = await openDoor(cookie, agentId)

    expect(throughToken.statusCode).toBe(200)
    expect(throughSession.statusCode).toBe(200)

    const normalised = (body: string, action: string) => body.split(action).join('{action}')

    expect(normalised(throughSession.body, `/agents/${agentId}/operator`)).toBe(
      normalised(throughToken.body, `/operator/page/${token}`),
    )
  })

  /**
   * The sentence moved with the channel (`#1444`). A sealed box is not what an
   * agent sends any more; it shares a stored entry, which the person reads on
   * this page. What is unchanged, and is the half that matters, is the
   * instruction not to send a secret any other way — a page that only refused
   * one and named nowhere else would be telling a person to solve it themselves.
   */
  it('names where a secret does go, when a key is configured', async () => {
    const token = await pages.issue(agentId, 'op@example.org')

    const response = await app.inject({ method: 'GET', url: `/operator/page/${token}` })

    expect(response.body).toContain('shares one of its stored entries')
    expect(response.body).toContain('Please do not send a secret any other way')
    expect(response.body).not.toContain('no key configured for secrets')
  })

  /**
   * **The token never appears in a page behind a login.**
   *
   * `#428`: *a durable bearer link displayed on a page behind a login is a
   * credential leaking downward for no gain — the human already has the better
   * door open.* Asserted on the body rather than trusted from the renderer's
   * signature, because the renderer is where it would come back.
   */
  it('does not put the durable token in the page it serves to a session', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const token = await pages.issue(agentId, 'op@example.org')

    const response = await openDoor(cookie, agentId)

    expect(response.body).not.toContain(token)
  })

  /**
   * The sealed boxes are gone (`#1444`).
   *
   * This asserted that a drop and a question interleaved by opening time, and
   * that only the signed-in door carried fill authority — a real property, on a
   * channel that was opened 7 times and filled **zero** times over its whole
   * lifetime. What replaces it is a shared vault entry, which **both** doors may
   * read and write: that reversal is `#1437` frozen decision 1 and it is
   * asserted in `packages/db/src/storage/operator-shares.test.ts`.
   *
   * The absence is kept as an assertion, because a form that quietly comes back
   * is what a removal invites.
   */
  it('offers no sealed-box form on either door', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const token = await pages.issue(agentId, 'op@example.org')

    const mailed = await app.inject({ method: 'GET', url: `/operator/page/${token}` })
    const throughSession = await openDoor(cookie, agentId)

    for (const body of [mailed.body, throughSession.body]) {
      expect(body).not.toContain('action="/drops/')
    }
  })

  /**
   * **The authorisation check is the whole security surface of this issue**, and
   * this is the case `#428` asks to be named.
   */
  it('refuses an agent this human does not operate', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    await pages.issue(otherAgentId, 'somebody@example.org')

    const response = await openDoor(cookie, otherAgentId)

    expect(response.statusCode).toBe(404)
  })

  it('refuses a signed-out browser', async () => {
    await pages.issue(agentId, 'op@example.org')

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/operator`,
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * **Revocation closes both doors**, which `#428` decided rather than assumed:
   * revocation is the citizen withdrawing the surface, and a door that survived
   * it would make revocation a thing the citizen only thinks it did.
   */
  it('closes when the citizen revokes the page, even though the session is still valid', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    await pages.issue(agentId, 'op@example.org')

    expect((await openDoor(cookie, agentId)).statusCode).toBe(200)

    await pages.revoke(agentId, 'op@example.org')

    expect((await openDoor(cookie, agentId)).statusCode).toBe(404)
  })

  /** An agent whose citizen never issued a page has no operator surface at all. */
  it('refuses an agent that never issued a page', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    expect((await openDoor(cookie, agentId)).statusCode).toBe(404)
  })

  /**
   * **Opening from the dashboard updates the same field.** `#381` found the
   * timestamp already ambiguous; two fields would settle nothing and add a second
   * thing to be wrong.
   */
  it('moves lastOpenedAt on the same field the mailed link moves', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    await pages.issue(agentId, 'op@example.org')

    expect((await pages.list(agentId))[0]?.lastOpenedAt).toBeNull()

    await openDoor(cookie, agentId)

    expect((await pages.list(agentId))[0]?.lastOpenedAt).not.toBeNull()
  })

  /**
   * **The session door writes, identically.** Approved by the maintainer,
   * 2026-08-05: a session is the stronger credential of the two, and giving it
   * less would be a rule with no argument behind it.
   */
  it('carries an unsolicited note to the agent, as the token door does', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    await pages.issue(agentId, 'op@example.org')

    const response = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/operator`,
      payload: new URLSearchParams({ intent: 'note', body: 'the account is made' }).toString(),
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })

    expect(response.statusCode).toBe(200)
  })

  /**
   * **The fixed controls work through this door too** (`#1093`). One renderer means
   * the session page carries the same three buttons, so a door that forwarded only
   * the words would refuse every press — and the person answering would meet a 422
   * on the control the page itself had offered them.
   */
  it('records what a pressed control declared, as the token door does', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    await pages.issue(agentId, 'op@example.org')
    const threadId = requests.store.giveThread(agentId)

    const response = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/operator`,
      payload: new URLSearchParams({
        intent: 'answer',
        threadId: String(threadId),
        kind: 'completion',
      }).toString(),
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })

    expect(response.statusCode).toBe(200)
    const seen = requests.store.messagesIn(threadId)
    expect(seen.at(-1)).toMatchObject({ author: 'operator', kind: 'completion' })
  })

  it('refuses a write for an agent this human does not operate', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    await pages.issue(otherAgentId, 'somebody@example.org')

    const response = await app.inject({
      method: 'POST',
      url: `/agents/${otherAgentId}/operator`,
      payload: new URLSearchParams({ intent: 'note', body: 'not mine to send' }).toString(),
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })

    expect(response.statusCode).toBe(404)
  })

  /** The console's paths stay on the console's host, like everything else here. */
  it('is not served on the API host', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    await pages.issue(agentId, 'op@example.org')

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/operator`,
      headers: { host: 'api.example', accept: 'text/html', cookie },
    })

    expect(response.statusCode).toBe(404)
  })
})
