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
import { OPERATOR_ANSWER_BODIES, OPERATOR_ANSWER_LABELS } from '@kolonie-ai/core'
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

  it('serves an empty page, not a 404, where the deployment wired no messaging (#1305)', async () => {
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

    const page = await get(cookie, id)
    expect(page.statusCode).toBe(200)
    expect(page.json()).toMatchObject({ threads: [], conversations: [], messages: [] })
  })
})

/**
 * The three fixed controls, and the thread each answer belongs to (`#1319`).
 *
 * **Two things the free-text path could not tell apart.** A person pressing
 * *You may go ahead* and a person pressing *I have done it* both used to send
 * the word *Allow*, and a person answering the second of two questions used to
 * send it into whichever thread the port found first. The first is fixed by the
 * kind, which the Colony turns into its own sentence; the second by the
 * `conversationId` the form carries.
 */
describe('the declaration, and the thread it answers (#1319)', () => {
  const KINDS = ['permission', 'completion', 'refusal'] as const

  it.each(KINDS)('sends the Colony’s own sentence for %s, with nothing typed', async (kind) => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const sent = await post(cookie, agentId, { kind })
    expect(sent.statusCode).toBe(200)

    const read = (await get(cookie, agentId)).json() as {
      messages: { body: string; answerKind?: string }[]
    }
    expect(read.messages[0]?.answerKind).toBe(kind)
    expect(read.messages[0]?.body).toBe(OPERATOR_ANSWER_BODIES[kind])
  })

  /**
   * The typed words are dropped rather than sent beside the sentence, so a
   * message declared `permission` can never carry a body saying it was done.
   */
  it('drops what was typed when a control was pressed', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    await post(cookie, agentId, { kind: 'permission', body: 'I already made the account.' })

    const read = (await get(cookie, agentId)).json() as { messages: { body: string }[] }
    expect(read.messages[0]?.body).toBe(OPERATOR_ANSWER_BODIES.permission)
  })

  it('refuses a kind it cannot read, and sends nothing', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const refused = await post(cookie, agentId, { kind: 'allow', body: 'Go on then.' })

    expect(refused.statusCode).toBe(422)
    expect((refused.json() as { messages: unknown[] }).messages).toHaveLength(0)
  })

  it('lands the answer in the thread it names rather than the first one', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const first = messages.thread(humanId, agentId)
    const second = messages.thread(humanId, agentId)

    const sent = await post(cookie, agentId, { kind: 'completion', conversationId: second })

    expect(sent.json()).toMatchObject({ conversationId: second })
    const read = (await get(cookie, agentId)).json() as {
      conversations: { id: string; messages: unknown[] }[]
    }
    expect(read.conversations.find((one) => one.id === first)?.messages).toHaveLength(0)
    expect(read.conversations.find((one) => one.id === second)?.messages).toHaveLength(1)
  })

  it('refuses a conversation that is not this person’s, exactly as it refuses nonsense', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    messages.thread(humanId, agentId)
    const strangers = messages.thread('another-person', strangersAgentId)

    const elsewhere = await post(cookie, agentId, {
      body: 'Wrong thread.',
      conversationId: strangers,
    })
    const nonsense = await post(cookie, agentId, {
      body: 'Not an id.',
      conversationId: 'not-an-id',
    })

    expect(elsewhere.statusCode).toBe(404)
    expect(nonsense.statusCode).toBe(422)
  })

  /** One form per thread, so there is no answer that cannot say what it answers. */
  it('renders a control set per thread, labelled for the person pressing it', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    messages.thread(humanId, agentId)
    messages.thread(humanId, agentId)

    const page = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/messages`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(page.statusCode).toBe(200)
    expect(page.body.split('name="conversationId"')).toHaveLength(3)
    for (const kind of KINDS) {
      expect(page.body).toContain(`value="${kind}"`)
      expect(page.body).toContain(OPERATOR_ANSWER_LABELS[kind])
    }
  })
})

/**
 * The inbox, over the console (`#1448`, epic `#1447`).
 *
 * **These assert the door rather than the model.** Ordering by activity, the
 * latest message, and unread from the cursor are asserted against real
 * PostgreSQL in `packages/db/src/storage/inbox.test.ts`. What is under test here
 * is what the epic is actually about: that a top-level route exists at all, that
 * it spans agents, that opening a thread writes the cursor, and that a thread
 * belonging to somebody else's agent is not reachable through it.
 */
describe('the inbox (#1448)', () => {
  const inbox = async (cookie: string) =>
    await app.inject({
      method: 'GET',
      url: '/inbox',
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })

  const openThread = async (cookie: string, conversationId: string, accept = 'application/json') =>
    await app.inject({
      method: 'GET',
      url: `/inbox/${conversationId}`,
      headers: { host: CONSOLE_HOST, accept, cookie },
    })

  it('spans every agent the person operates', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    await operates(strangersAgentId)
    messages.thread(human, String(agentId))
    messages.thread(human, String(strangersAgentId))

    const listed = await inbox(cookie)

    expect(listed.statusCode).toBe(200)
    expect((listed.json() as { threads: unknown[] }).threads).toHaveLength(2)
  })

  it('is a top-level page a signed-in person can reach', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const rendered = await app.inject({
      method: 'GET',
      url: '/inbox',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(rendered.statusCode).toBe(200)
    expect(rendered.body).toContain('Your inbox')
  })

  it('opens a thread, and opening it is what marks it read', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))

    await post(cookie, agentId, { body: 'Something to read.', conversationId: thread })

    const opened = await openThread(cookie, thread)
    expect(opened.statusCode).toBe(200)
    expect((opened.json() as { messages: unknown[] }).messages).toHaveLength(1)

    // The write the console never made. Before it, `unread` did not exist for a
    // person at all — only *never answered*.
    const after = await inbox(cookie)
    const rows = (after.json() as { threads: { unread: boolean }[] }).threads
    expect(rows.every((row) => !row.unread)).toBe(true)
  })

  it('replies in place, through the existing rules', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))

    const sent = await app.inject({
      method: 'POST',
      url: `/inbox/${thread}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
      payload: { body: 'The account is @ariadne.' },
    })

    expect(sent.statusCode).toBe(200)
    expect(sent.json()).toMatchObject({ outcome: 'delivered' })
  })

  it('refuses a credential-shaped reply, exactly as the older door does', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))

    const refused = await app.inject({
      method: 'POST',
      url: `/inbox/${thread}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
      payload: { body: 'the password is hunter2 and the token is ghp_0123456789abcdefghij' },
    })

    expect(refused.statusCode).toBe(422)
  })

  it('does not reach a thread of an agent this person does not operate', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    // A thread belonging to somebody else entirely: no participant row, so the
    // store answers exactly as it does for an id that names nothing.
    const theirs = messages.thread('11111111-1111-4111-8111-111111111111', String(agentId))

    const opened = await openThread(cookie, theirs, 'text/html')
    expect(opened.statusCode).toBe(404)

    const posted = await app.inject({
      method: 'POST',
      url: `/inbox/${theirs}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      payload: { body: 'Not mine to write in.' },
    })
    expect(posted.statusCode).toBe(404)
  })
})
