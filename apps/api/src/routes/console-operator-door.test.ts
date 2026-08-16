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
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import type { DropStore } from '../operator-drops.js'
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
let requests: ReturnType<typeof fakeOperatorRequests>
let drops: DropStore
let pageDrops: Awaited<ReturnType<DropStore['forPageToken']>>
let agentId: AgentId
let otherAgentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  pages = fakeOperatorPages()
  requests = fakeOperatorRequests({ pages })
  pageDrops = []
  drops = {
    open: () => Promise.reject(new Error('not used')),
    view: () => Promise.resolve(null),
    submit: () => Promise.resolve({ outcome: 'closed' }),
    list: () => Promise.resolve([]),
    forPageToken: () => Promise.resolve(pageDrops),
    take: () => Promise.resolve({ outcome: 'nothing' }),
    fillAsOperator: () => Promise.resolve({ outcome: 'closed' }),
  }
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
    operatorRequests: requests,
    operatorNotes: fakeOperatorNotes({ pages }),
    drops,
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

  it('promises a sealed box when the secret channel is configured', async () => {
    const token = await pages.issue(agentId, 'op@example.org')

    const response = await app.inject({ method: 'GET', url: `/operator/page/${token}` })

    expect(response.body).toContain('will send you a <strong>sealed box</strong>')
    expect(response.body).toContain('Please do not send a secret any other way')
    expect(response.body).not.toContain('no channel configured for secrets')
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

  it('orders questions and sealed boxes by opening, without giving the page token fill authority', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const token = await pages.issue(agentId, 'op@example.org')
    const taskId = requests.store.giveTask()
    await requests.store.open({ agentId, taskId, body: 'The question between the two drops' })
    pageDrops = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'credential',
        prompt: 'The older mailbox password',
        createdAt: '2000-01-01T00:00:00.000Z' as never,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'code',
        prompt: 'The later verification code',
        createdAt: '2999-01-01T00:00:00.000Z' as never,
      },
    ]

    const mailed = await app.inject({ method: 'GET', url: `/operator/page/${token}` })
    const throughSession = await openDoor(cookie, agentId)

    for (const body of [mailed.body, throughSession.body]) {
      expect(body.indexOf('The older mailbox password')).toBeLessThan(
        body.indexOf('The question between the two drops'),
      )
      expect(body.indexOf('The question between the two drops')).toBeLessThan(
        body.indexOf('The later verification code'),
      )
    }
    expect(mailed.body).not.toContain('action="/drops/')
    expect(throughSession.body).toContain('action="/drops/11111111-1111-4111-8111-111111111111"')
    expect(throughSession.body).toContain('action="/drops/22222222-2222-4222-8222-222222222222"')
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
    const taskId = requests.store.giveTask()
    const opened = await requests.store.open({ agentId, taskId, body: 'Please make the account.' })
    if (opened.outcome !== 'opened') throw new Error(`expected opened, got ${opened.outcome}`)

    const response = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/operator`,
      payload: new URLSearchParams({
        intent: 'answer',
        requestId: opened.request.id,
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
    const seen = await requests.store.read({ agentId, requestId: opened.request.id })
    expect(seen?.declared).toBe('completion')
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
