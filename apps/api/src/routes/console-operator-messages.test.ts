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

/**
 * The per-agent page, which is the inbox narrowed to one agent since `#1453`.
 *
 * The JSON branch answers with the inbox's own shape — `threads`, ordered by
 * activity — rather than the concatenated page `operatorThreadPage` built. The
 * messages of one thread are read where they are now read, through
 * {@link readThread}.
 */
const get = async (cookie: string, id: AgentId) =>
  await app.inject({
    method: 'GET',
    url: `/agents/${id}/messages`,
    headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
  })

/** The threads on that page, in the shape the inbox answers with. */
const threadsOf = async (cookie: string, id: AgentId) =>
  ((await get(cookie, id)).json() as { threads: { conversationId: string }[] }).threads

/** One thread's messages, from the surface that reads a conversation. */
const readThread = async (cookie: string, conversationId: string) =>
  (
    (
      await app.inject({
        method: 'GET',
        url: `/inbox/${conversationId}`,
        headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
      })
    ).json() as { messages: { body: string; answerKind?: string; sender: { party: string } }[] }
  ).messages

/** The newest message of the only thread this agent has. */
const latestTo = async (cookie: string, id: AgentId) => {
  const threads = await threadsOf(cookie, id)
  if (threads[0] === undefined) return undefined
  const messages = await readThread(cookie, threads[0].conversationId)
  return messages.at(-1)
}

describe('an operator writing to their citizen (#1288)', () => {
  it('sends, and reads it back labelled as the person rather than the Colony', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const sent = await post(cookie, agentId, { body: 'The account is @ariadne.' })
    expect(sent.statusCode).toBe(200)
    expect(sent.json()).toMatchObject({ outcome: 'delivered' })

    const page = await get(cookie, agentId)
    expect(page.statusCode).toBe(200)
    expect(await threadsOf(cookie, agentId)).toHaveLength(1)

    const latest = await latestTo(cookie, agentId)
    expect(latest?.body).toBe('The account is @ariadne.')
    expect(latest?.sender.party).toBe('operator-human')
  })

  it('keeps one thread for the person, however many times they write', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const first = await post(cookie, agentId, { body: 'One.' })
    const second = await post(cookie, agentId, { body: 'Two.' })

    expect(second.json()).toMatchObject({
      conversationId: (first.json() as { conversationId: string }).conversationId,
    })
    expect(await threadsOf(cookie, agentId)).toHaveLength(1)
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
    // An empty page and not a 404 (`#1305`), through the inbox's own shape.
    expect(page.json()).toMatchObject({ threads: [] })
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

    const latest = await latestTo(cookie, agentId)
    expect(latest?.answerKind).toBe(kind)
    expect(latest?.body).toBe(OPERATOR_ANSWER_BODIES[kind])
  })

  /**
   * The typed words are dropped rather than sent beside the sentence, so a
   * message declared `permission` can never carry a body saying it was done.
   */
  it('drops what was typed when a control was pressed', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    await post(cookie, agentId, { kind: 'permission', body: 'I already made the account.' })

    expect((await latestTo(cookie, agentId))?.body).toBe(OPERATOR_ANSWER_BODIES.permission)
  })

  it('refuses a kind it cannot read, and sends nothing', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const refused = await post(cookie, agentId, { kind: 'allow', body: 'Go on then.' })

    expect(refused.statusCode).toBe(422)
    // Nothing was sent: the agent has no thread at all.
    expect(await threadsOf(cookie, agentId)).toHaveLength(0)
  })

  it('lands the answer in the thread it names rather than the first one', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const first = messages.thread(humanId, agentId)
    const second = messages.thread(humanId, agentId)

    const sent = await post(cookie, agentId, { kind: 'completion', conversationId: second })

    expect(sent.json()).toMatchObject({ conversationId: second })
    expect(await readThread(cookie, first)).toHaveLength(0)
    expect(await readThread(cookie, second)).toHaveLength(1)
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
  /**
   * **The controls moved with the thread view** (`#1453`). They used to be one
   * set per thread on a page that concatenated all of them; now a thread is
   * opened and answered on its own page, so there is one set on the thread
   * being answered rather than a form for every conversation at once.
   *
   * The property that mattered — *a declaration always names the thread it
   * belongs to* — is asserted by the test above this, which is where it should
   * have been all along: it is about the message, not about the markup.
   */
  it('renders the three controls, labelled for the person pressing it', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const thread = messages.thread(humanId, agentId)

    const page = await app.inject({
      method: 'GET',
      url: `/inbox/${thread}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(page.statusCode).toBe(200)
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

/**
 * Archive, mute and the view switch, over the console (`#1449`).
 *
 * The interaction rules — that a new message un-archives, that archiving does
 * not mark read, that neither reaches an agent — are asserted against real
 * PostgreSQL in `packages/db/src/storage/inbox.test.ts`. What is under test here
 * is the door: that the acts exist, that the list narrows, and that a thread
 * belonging to somebody else cannot be archived through it.
 */
describe('what a person has done with a thread (#1449)', () => {
  const inbox = async (cookie: string, view?: string) =>
    await app.inject({
      method: 'GET',
      url: view === undefined ? '/inbox' : `/inbox?view=${view}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })

  const act = async (cookie: string, conversationId: string, what: string) =>
    await app.inject({
      method: 'POST',
      url: `/inbox/${conversationId}/state`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
      payload: { act: what },
    })

  const threadsOf = (response: { json: () => unknown }) =>
    (response.json() as { threads: { conversationId: string; archived: boolean }[] }).threads

  it('archives out of the open list and back again', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))

    expect((await act(cookie, thread, 'archive')).statusCode).toBe(200)
    expect(threadsOf(await inbox(cookie))).toHaveLength(0)
    expect(threadsOf(await inbox(cookie, 'archived'))).toHaveLength(1)
    expect(threadsOf(await inbox(cookie, 'all'))).toHaveLength(1)

    await act(cookie, thread, 'unarchive')
    expect(threadsOf(await inbox(cookie))).toHaveLength(1)
  })

  it('brings an archived thread back when the agent writes', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))
    await act(cookie, thread, 'archive')

    messages.agentWrites(human, String(agentId), 'One more thing.')

    // Archive means *I am done with this*, and somebody writing again is the
    // event that makes it untrue.
    expect(threadsOf(await inbox(cookie))).toHaveLength(1)
  })

  it('leaves a muted thread in the list', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))

    expect((await act(cookie, thread, 'mute')).statusCode).toBe(200)

    const rows = ((await inbox(cookie)).json() as { threads: { muted: boolean }[] }).threads
    expect(rows).toHaveLength(1)
    expect(rows[0]?.muted).toBe(true)
  })

  it('offers the switch on the page', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const rendered = await app.inject({
      method: 'GET',
      url: '/inbox',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(rendered.body).toContain('/inbox?view=archived')
    expect(rendered.body).toContain('/inbox?view=all')
  })

  it('does not archive a thread of an agent this person does not operate', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)
    const theirs = messages.thread('11111111-1111-4111-8111-111111111111', String(agentId))

    const refused = await app.inject({
      method: 'POST',
      url: `/inbox/${theirs}/state`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      payload: { act: 'archive' },
    })

    expect(refused.statusCode).toBe(404)
  })
})

/**
 * A person starting a thread from the inbox (`#1452`).
 *
 * **The store already opened threads**, which is the issue's first acceptance
 * criterion and is asserted in `packages/db/src/storage/inbox.test.ts` — that a
 * send with no `conversationId` opens one, that a second lands in the same
 * plain thread, and that an account narrows it. What is under test here is the
 * surface: that the form exists, that the refusals are the existing ones, and
 * that an agent this person does not operate is refused.
 */
describe('a person starting a thread (#1452)', () => {
  const compose = async (cookie: string, payload: Record<string, unknown>) =>
    await app.inject({
      method: 'POST',
      url: '/inbox/compose',
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
      payload,
    })

  it('offers the form on the inbox', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const rendered = await app.inject({
      method: 'GET',
      url: '/inbox',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(rendered.body).toContain('action="/inbox/compose"')
    // No subject line: a thread's subject is what it is about, and those are
    // chosen rather than typed.
    expect(rendered.body).not.toContain('name="subject"')
  })

  it('opens a thread nobody asked for', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const sent = await compose(cookie, { agentId, body: 'The account is @ariadne.' })

    expect(sent.statusCode).toBe(200)
    expect(sent.json()).toMatchObject({ outcome: 'delivered' })

    const listed = await app.inject({
      method: 'GET',
      url: '/inbox',
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })
    expect((listed.json() as { threads: unknown[] }).threads).toHaveLength(1)
  })

  it('refuses a credential-shaped body with the existing wording', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const refused = await compose(cookie, {
      agentId,
      body: 'the password is hunter2 and the token is ghp_0123456789abcdefghij',
    })

    expect(refused.statusCode).toBe(422)
  })

  it('refuses an empty body', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    expect((await compose(cookie, { agentId, body: '   ' })).statusCode).toBe(422)
  })

  it('refuses an agent this person does not operate', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const refused = await compose(cookie, {
      agentId: strangersAgentId,
      body: 'Not mine to write to.',
    })

    expect(refused.statusCode).toBe(403)
  })
})

/**
 * Filters and search, as query parameters (`#1450`).
 *
 * **The SQL is asserted against real PostgreSQL** in
 * `packages/db/src/storage/inbox.test.ts`, including the one that matters — that
 * no filter and no search reaches a thread this person is not in. What is under
 * test here is the other half: that the query string becomes those options, that
 * a filtered inbox is a link somebody can keep, and that acting on a thread
 * lands back in the list they were looking at.
 */

/**
 * Filters and search, as query parameters (`#1450`).
 *
 * **The SQL is asserted against real PostgreSQL** in
 * `packages/db/src/storage/inbox.test.ts`, including the one that matters — that
 * no filter and no search reaches a thread this person is not in. What is under
 * test here is the other half: that the query string becomes those options, that
 * a filtered inbox is a link somebody can keep, and that acting on a thread
 * lands back in the list they were looking at.
 */
describe('narrowing the inbox (#1450)', () => {
  const listed = async (cookie: string, query = '') =>
    await app.inject({
      method: 'GET',
      url: `/inbox${query}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })

  const ids = (answered: { json: () => unknown }): string[] =>
    (answered.json() as { threads: { conversationId: string }[] }).threads.map(
      (thread) => thread.conversationId,
    )

  it('narrows to what this person has written in, and to what is unread', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const answered = messages.thread(human, String(agentId))
    const waiting = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'May I open a mailbox?', answered)
    messages.agentWrites(human, String(agentId), 'And this one?', waiting)

    await app.inject({
      method: 'POST',
      url: `/inbox/${answered}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
      payload: { body: 'Yes, go ahead.' },
    })
    // Opening is what marks read (`#1448`) — replying does not, and the two
    // being separate acts is why they are separate filters.
    await app.inject({
      method: 'GET',
      url: `/inbox/${answered}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })

    expect(ids(await listed(cookie, '?sent=1'))).toEqual([answered])
    expect(ids(await listed(cookie, '?unread=1'))).toEqual([waiting])
  })

  it('searches the body of every message, not only the latest', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const wanted = messages.thread(human, String(agentId))
    const other = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'The registrar is njalla.', wanted)
    messages.agentWrites(human, String(agentId), 'Noted, thank you.', wanted)
    messages.agentWrites(human, String(agentId), 'Nothing to do with that.', other)

    expect(ids(await listed(cookie, '?q=njalla'))).toEqual([wanted])
  })

  it('combines a search with a filter rather than replacing it', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'The registrar is njalla.', thread)

    // Unread and matching: both predicates hold.
    expect(ids(await listed(cookie, '?q=njalla&unread=1'))).toEqual([thread])
    // Matching and not written in: one holds, the other does not, and the
    // answer is empty rather than one of them winning.
    expect(ids(await listed(cookie, '?q=njalla&sent=1'))).toEqual([])
  })

  it('reports what it narrowed by, so the page can reflect it back', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const narrowed = (await listed(cookie, `?agent=${agentId}&unread=1&q=njalla`)).json() as {
      filters: Record<string, unknown>
    }

    expect(narrowed.filters).toMatchObject({
      agentId: String(agentId),
      unreadOnly: true,
      search: 'njalla',
    })
  })

  it('ignores a malformed filter rather than refusing the page', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'Still here.', thread)

    // Somebody's mangled link. An inbox that answers 400 to one is worse than
    // an inbox that answers with the unfiltered list.
    const answered = await listed(cookie, '?agent=not-a-uuid')

    expect(answered.statusCode).toBe(200)
    expect(ids(answered)).toEqual([thread])
  })

  it('keeps the filters in the view switch and in the buttons', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'The registrar is njalla.', thread)

    const rendered = await app.inject({
      method: 'GET',
      url: '/inbox?q=njalla',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    // A filtered inbox is a link somebody can keep — including the link that
    // switches the view, and including where archiving returns to. A filter
    // that survived reading but not acting would be the worse half.
    expect(rendered.body).toMatch(/href="\/inbox\?[^"]*q=njalla[^"]*"/)
    expect(rendered.body).toMatch(/name="back" value="\/inbox\?[^"]*q=njalla/)
  })
})

/**
 * The queue becomes a count, and the per-agent page becomes a filter (`#1453`).
 *
 * `waitingForOperator` asked *has the operator written in this thread* and
 * answered *no* exactly once per thread ever, which hid 46 of 52 conversations
 * in production — sixteen of them while genuinely waiting. The argument it took
 * with it, that a work queue should be ordered by what each item costs to clear
 * rather than by age, is kept in
 * `kolonie-docs/state/decisions/the-queue-becomes-a-count.md`.
 */
describe('the dashboard after the queue (#1453)', () => {
  const dashboard = async (cookie: string, accept = 'application/json') =>
    await app.inject({ method: 'GET', url: '/', headers: { host: CONSOLE_HOST, accept, cookie } })

  it('counts the unread and links to the inbox', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const one = messages.thread(human, String(agentId))
    const two = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'May I?', one)
    messages.agentWrites(human, String(agentId), 'And may I?', two)

    expect((await dashboard(cookie)).json()).toMatchObject({ unreadThreads: 2 })

    const rendered = await dashboard(cookie, 'text/html')
    expect(rendered.body).toContain('/inbox?unread=1')
    expect(rendered.body).toContain('2 unread conversations')
    // The queue's own vocabulary is gone from the page entirely.
    expect(rendered.body).not.toContain('Shortest first')
  })

  it('shows no section at all when nothing is unread', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'May I?', thread)

    await app.inject({
      method: 'GET',
      url: `/inbox/${thread}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })

    // A heading over an empty count teaches a person that this page usually has
    // nothing on it — the same rule the queue had.
    expect((await dashboard(cookie)).json()).toMatchObject({ unreadThreads: 0 })
    expect((await dashboard(cookie, 'text/html')).body).not.toContain('Waiting on you')
  })

  it('never counts a thread of an agent this person does not operate', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)
    const theirs = messages.thread('11111111-1111-4111-8111-111111111111', String(strangersAgentId))
    messages.agentWrites(
      '11111111-1111-4111-8111-111111111111',
      String(strangersAgentId),
      'Hm?',
      theirs,
    )

    expect((await dashboard(cookie)).json()).toMatchObject({ unreadThreads: 0 })
  })

  it('sends the per-agent page into the inbox, narrowed to that agent', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const sent = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/messages`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    // The route stays (`#1447` frozen decision 6) so the agent's own navigation
    // keeps its meaning; the second renderer that used to be behind it goes.
    expect(sent.statusCode).toBe(303)
    expect(sent.headers['location']).toBe(`/inbox?agent=${agentId}`)
  })

  it('narrows to the agent in the path, whatever the query string says', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const mine = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'From the one you asked for.', mine)

    const listed = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/messages?agent=${strangersAgentId}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })

    // One link contradicting itself. The path is the one the person clicked.
    expect((listed.json() as { threads: { conversationId: string }[] }).threads).toEqual([
      expect.objectContaining({ conversationId: mine }),
    ])
  })
})
