import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * The agent page (`#452`).
 *
 * **A window rather than a control panel**, and that is the property most of
 * these tests are circling. The page assembles what the Colony already holds
 * about one agent for the person paying for its runtime; nothing on it mutates
 * the agent, and an agent somebody does not operate is indistinguishable from
 * one that does not exist.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let pages: ReturnType<typeof fakeOperatorPages>
let agentId: AgentId
let strangersAgentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  pages = fakeOperatorPages()
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
      formBaseUrl: CONSOLE_URL,
    },
  })
  await app.ready()

  agentId = agents.issue().agent.id
  strangersAgentId = agents.issue().agent.id
  pages.exists(agentId)
  pages.exists(strangersAgentId)
})

afterEach(async () => {
  await app?.close()
})

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

/** Through the code path `#426` built, so this authorises against the table the route reads. */
const link = async (id: AgentId): Promise<void> => {
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, human.id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
}

const openPage = (cookie: string, id: AgentId, zone = 'Europe/Berlin') =>
  app.inject({
    method: 'GET',
    url: `/agents/${id}`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie, 'cf-timezone': zone },
  })

describe('the agent page', () => {
  it('shows identity, standing, balance and activity behind a session', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    pages.nameFor(agentId, 'canary')
    pages.factsFor(agentId, {
      skills: ['mailbox', 'profile'],
      lastSeenAt: new Date(Date.now() - 2 * 3_600_000).toISOString() as never,
      attempts: [
        {
          rung: 'email-inbox',
          kind: 'academy',
          at: new Date().toISOString() as never,
          outcome: 'passed',
        },
      ],
    })

    const response = await openPage(cookie, agentId)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('canary')
    expect(response.body).toContain('Standing')
    expect(response.body).toContain('Balance')
    expect(response.body).toContain('mailbox')
    expect(response.body).toContain('email-inbox')
    expect(response.body).toContain('2 hours ago')
  })

  /**
   * **The rejection case, and it is the one that matters.** A page that answered
   * differently for *not yours* and *does not exist* would be a way to find out
   * which agent ids are real from a console session.
   */
  it('answers an agent this person does not operate exactly as a missing one', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const strangers = await openPage(cookie, strangersAgentId)
    const nobodys = await openPage(cookie, '99999999-9999-4999-8999-999999999999' as AgentId)

    expect(strangers.statusCode).toBe(404)
    expect(nobodys.statusCode).toBe(404)
    expect(strangers.body).toBe(nobodys.body)
  })

  it('is not reachable without a session at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * **This is what `#451`'s link was landing on.** The mailed door needs a live
   * operator page and 404s without one; the console's page is reached through
   * the join table and does not care whether a citizen ever mailed anybody.
   */
  it('opens for an agent that has never issued an operator page', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    expect(await pages.liveToken(agentId)).toBeUndefined()
    expect((await openPage(cookie, agentId)).statusCode).toBe(200)
  })

  /**
   * **An agent that has done nothing gets sentences, not dashes.** This is the
   * case the page has to say something about, because it is what a person sees
   * on the day they set an agent up.
   */
  it('renders a deliberate empty state that says what happens next', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openPage(cookie, agentId)).body

    expect(body).toContain('None yet')
    expect(body).toContain('Nothing attempted yet')
    expect(body).toContain('Nothing on account')
    expect(body).not.toContain('<td>—</td>')
  })

  /** Quests are `#454`'s, and a heading that promised them would be the placeholder it refuses. */
  it('promises no quests it cannot show yet', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openPage(cookie, agentId)).body

    expect(body).not.toContain('Quests')
    expect(body).not.toContain('coming soon')
  })

  /** Nothing on it writes, and the rule that says so is on the page. */
  it('offers nothing that changes the agent', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openPage(cookie, agentId)).body

    expect(body).toContain('a window rather than a control panel')
    /**
     * **No form that posts at this agent.** The page carries the console
     * header's sign-out, which posts at the *session* and is furniture on every
     * signed-in page — so the assertion is about the target rather than about
     * the tag. `#453` adds exactly one form here, the operator note, and it
     * reaches words and never a permission.
     */
    expect(body).not.toMatch(/<form[^>]*action="\/agents\//)
    expect(body).not.toContain('<script')
  })

  /** `#461`'s rule reaches this page too: no time is printed without its clock. */
  it('renders its dates in the visitor’s zone', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    expect((await openPage(cookie, agentId)).body).toContain('Europe/Berlin')
    expect((await openPage(cookie, agentId, 'nonsense')).body).toContain('UTC')
  })

  /** An agent may drive the console with its key, so this answers JSON as well. */
  it('answers the same page as JSON', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ name: 'canary', citizenship: 'candidate' })
  })
})
