import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { fakeOperatorMessaging, type FakeOperatorMessaging } from '../__fixtures__/messaging.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * The operator's own direction, over the console (`#1288`, epic `#1284`).
 *
 * **These assert the route rather than the model.** What a thread is, that one
 * person gets one of them, and that removing the relationship leaves it
 * read-only are asserted against real PostgreSQL in
 * `packages/db/src/storage/messaging.test.ts`. What is under test here is the
 * door: who it answers, that a person who does not operate this agent is told
 * nothing, and that a body which looks like a credential is refused before it
 * lands in an agent's context.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let colony: FakeColony
let messages: FakeOperatorMessaging
let agentId: AgentId
let strangersAgentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  const pages = fakeOperatorPages()
  const agents = fakeStore()
  colony = fakeColony()
  messages = fakeOperatorMessaging()

  app = buildApp({
    ...colony,
    operatorMessaging: messages,
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

/** The signed-in person operates this agent, on both fakes. */
const operates = async (id: AgentId): Promise<string> => {
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, human.id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
  messages.link(human.id, id)
  return human.id
}

const post = async (cookie: string, id: AgentId, body: Record<string, unknown>) =>
  await app.inject({
    method: 'POST',
    url: `/agents/${id}/messages`,
    headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    payload: body,
  })

const get = async (cookie: string, id: AgentId) =>
  await app.inject({
    method: 'GET',
    url: `/agents/${id}/messages`,
    headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
  })

describe('an operator writing to their citizen (#1288)', () => {
  it('sends, and reads it back labelled as the person rather than the Colony', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const sent = await post(cookie, agentId, { body: 'The account is @ariadne.' })
    expect(sent.statusCode).toBe(200)
    expect(sent.json()).toMatchObject({ outcome: 'delivered' })

    const page = await get(cookie, agentId)
    expect(page.statusCode).toBe(200)
    const read = page.json() as {
      threads: { kind: string }[]
      messages: { body: string; sender: { party: string } }[]
    }
    expect(read.threads).toHaveLength(1)
    expect(read.threads[0]?.kind).toBe('operator-human')
    expect(read.messages[0]?.body).toBe('The account is @ariadne.')
    expect(read.messages[0]?.sender.party).toBe('operator-human')
  })

  it('keeps one thread for the person, however many times they write', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const first = await post(cookie, agentId, { body: 'One.' })
    const second = await post(cookie, agentId, { body: 'Two.' })

    expect(second.json()).toMatchObject({
      conversationId: (first.json() as { conversationId: string }).conversationId,
    })
    expect((await get(cookie, agentId)).json()).toMatchObject({
      threads: [expect.anything()],
    })
  })

  /**
   * **The spoof, from the console's side.** A person who does not operate this
   * agent gets what they get for an id that names nothing — so the route cannot
   * be used to find out which agents exist, and cannot be used to write to one.
   */
  it('answers a person who does not operate the agent exactly as it answers nonsense', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const read = await get(cookie, strangersAgentId)
    const written = await post(cookie, strangersAgentId, { body: 'Not mine to write to.' })

    expect(read.statusCode).toBe(404)
    expect(written.statusCode).toBe(404)
  })

  it('is closed to a citizen’s own credential, session or no session', async () => {
    await signedInCookie()
    await operates(agentId)

    const asAgent = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/messages`,
      headers: { host: CONSOLE_HOST, accept: 'application/json' },
      payload: { body: 'I am my own operator.' },
    })

    expect(asAgent.statusCode).toBe(404)
  })

  it('refuses once the relationship has been removed, and says why', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    await post(cookie, agentId, { body: 'While it lasted.' })

    messages.unlink(humanId, agentId)
    const refused = await post(cookie, agentId, { body: 'One more thing.' })

    expect(refused.statusCode).toBe(403)
    expect((refused.json() as { error: string }).error).toContain('operator link')
  })

  it('refuses an empty body and one that carries a credential', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const empty = await post(cookie, agentId, { body: '   ' })
    expect(empty.statusCode).toBe(422)

    const secret = await post(cookie, agentId, {
      body: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123 for the repo.',
    })
    expect(secret.statusCode).toBe(422)
    expect((secret.json() as { error: string }).error).toBeTruthy()
  })

  it('serves nothing where the deployment wired no messaging', async () => {
    await app.close()
    const pages = fakeOperatorPages()
    const agents = fakeStore()
    humans = fakeHumanStore()
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
    const id = agents.issue().agent.id
    pages.exists(id)

    const cookie = await signedInCookie()
    await operates(id)

    expect((await get(cookie, id)).statusCode).toBe(404)
  })
})
