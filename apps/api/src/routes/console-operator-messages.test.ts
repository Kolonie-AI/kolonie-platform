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
import { fakeAccountRegister } from '../__fixtures__/accounts.js'
import { AccountKindSchema, OPERATOR_ANSWER_BODIES, OPERATOR_ANSWER_LABELS } from '@kolonie-ai/core'
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
/** The register the compose picker is built from (`#1551`). */
let register: ReturnType<typeof fakeAccountRegister>
let agentId: AgentId
let strangersAgentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  const pages = fakeOperatorPages()
  const agents = fakeStore()
  colony = fakeColony()
  messages = fakeOperatorMessaging()
  register = fakeAccountRegister()

  app = buildApp({
    ...colony,
    accounts: { ...colony.accounts, register },
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
    /**
     * A sealing key is configured (`#1444`, `#1574`).
     *
     * **The thread's share forms branch on this**, and rightly: without a key
     * nothing can be shared, so offering a write box would be offering a control
     * that always refuses. Nothing here shares anything — what the thread renders
     * comes from `getThread`, and this only says the Colony could carry one.
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
   * **Refused rather than dropped, since `#1548`.**
   *
   * A message declared `permission` still can never carry a body saying it was
   * done — that guarantee is unchanged and is why this is refused. What changed
   * is which way it is enforced. It used to throw the words away silently, which
   * is the defect `#1548` is named for; this is the JSON door, no page has
   * posted a form here since `#1547`, and a caller sending both halves of an
   * answer that disagree gets told so rather than having one picked for it.
   *
   * The page's own answer to the same question is `answerKindOfBody`: one form,
   * and the tag follows the body.
   */
  it('refuses a control and typed words together, rather than dropping the words', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const refused = await post(cookie, agentId, {
      kind: 'permission',
      body: 'I already made the account.',
    })

    expect(refused.statusCode).toBe(422)
    expect(await threadsOf(cookie, agentId)).toHaveLength(0)
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

  it('renders the share lifecycle in the canonical supplied order', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))
    const at = '2026-08-24T12:00:00.000Z'
    messages.shareOnThread(thread, {
      events: [
        { vaultKey: 'provider/first', kind: 'shared', at },
        { vaultKey: 'provider/second', kind: 'shared', at },
        { vaultKey: 'provider/first', kind: 'read', at },
        { vaultKey: 'provider/second', kind: 'read', at },
        { vaultKey: 'provider/first', kind: 'written', at },
        { vaultKey: 'provider/second', kind: 'written', at },
        { vaultKey: 'provider/first', kind: 'handed-back', at },
        { vaultKey: 'provider/second', kind: 'handed-back', at },
      ],
    })

    const rendered = await openThread(cookie, thread, 'text/html')
    const lifecycle = rendered.body.slice(rendered.body.indexOf('<ul class="share-events">'))
    const expected = [
      'provider/first</code> — shared with you',
      'provider/second</code> — shared with you',
      'provider/first</code> — opened',
      'provider/second</code> — opened',
      'provider/first</code> — you wrote something into it',
      'provider/second</code> — you wrote something into it',
      'provider/first</code> — handed back',
      'provider/second</code> — handed back',
    ]

    expect(rendered.statusCode).toBe(200)
    expect(rendered.body).toContain('What has happened to what was shared here')
    let previous = -1
    for (const needle of expected) {
      const position = lifecycle.indexOf(needle)
      expect(position).toBeGreaterThan(previous)
      previous = position
    }
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
 * Archive and the view switch, over the console (`#1449`; mute withdrawn by
 * `#1549`).
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

  /**
   * **The door mute used to be behind is closed** (`#1549`). Nobody had ever
   * used it — 0 of 107 participants — and the route took an `act`, so a removal
   * that left the branch answering would be a control nothing renders and
   * anything can still post to.
   */
  it('refuses an act that is no longer offered', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const thread = messages.thread(human, String(agentId))

    expect((await act(cookie, thread, 'mute')).statusCode).toBe(404)
    expect((await act(cookie, thread, 'unmute')).statusCode).toBe(404)
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
    /**
     * **No free-text subject** (`#1452`, and `#1551` which added the picker). A
     * thread's subject is what it is *about* — a task, an account — and those
     * are chosen from what exists. A typed one would be a second, competing
     * notion of what a thread is about, and unlike the real one it would mean
     * nothing to the agent.
     *
     * The needle is the *input*, not the name: `#1551`'s picker is a `select`
     * called `about`, and asserting the name alone would have gone quiet the
     * moment somebody added a box beside it.
     */
    expect(rendered.body).not.toContain('name="subject"')
    expect(rendered.body).not.toMatch(/<input[^>]*name="about"/)
    expect(rendered.body).not.toMatch(/<textarea[^>]*name="about"/)
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

/**
 * Telling the three parties apart at a glance (`#1427`).
 *
 * **The rule underneath the whole channel** is that a reader can tell the
 * Colony's words from a person's without reading them (`#236`), and `#1289` made
 * it load-bearing here by putting `system-role` messages in the same inbox as an
 * operator's own. The console rendered `class="from-<party>"` and nothing else —
 * the fact reached CSS and stopped there, so a reader with no stylesheet, or one
 * who does not perceive the hue, read three parties identically.
 *
 * The durable operator page has said this in words since `#1445` — *You wrote*,
 * *The Colony wrote*, *<agent> wrote*. These assert the console now does too.
 */
describe('who wrote it, as a mark (#1427)', () => {
  const threadHtml = async (cookie: string, conversationId: string): Promise<string> =>
    (
      await app.inject({
        method: 'GET',
        url: `/inbox/${conversationId}`,
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      })
    ).body

  it('marks all three parties in the markup, not only in a class', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const conversation = messages.thread(human, String(agentId))
    messages.colonyWrites(human, String(agentId), 'Open a mailbox for this agent.', conversation)
    messages.agentWrites(human, String(agentId), 'Thank you — that is what I needed.', conversation)
    await app.inject({
      method: 'POST',
      url: `/inbox/${conversation}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
      payload: { body: 'Done, the address is in your vault.' },
    })

    const html = await threadHtml(cookie, conversation)

    // The words, which is the half a stylesheet cannot take away.
    expect(html).toContain('>Colony</span>')
    expect(html).toContain('>Agent</span>')
    expect(html).toContain('>You</span>')
    // And the hook the stylesheet colours, which was all there was before.
    expect(html).toContain('class="party party--system-role"')
    expect(html).toContain('class="party party--citizen"')
    expect(html).toContain('class="party party--operator-human"')
  })

  /**
   * **A mark is not a second name for the sender.** `senderLabel` answers *who*
   * and the mark answers *what kind of party*, and a page that dropped one for
   * the other would have made the change a rename.
   */
  it('keeps the sender label beside the mark', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const conversation = messages.thread(human, String(agentId))
    messages.colonyWrites(human, String(agentId), 'Open a mailbox for this agent.', conversation)

    const html = await threadHtml(cookie, conversation)

    expect(html).toContain('>Colony</span> <strong>the Colony</strong>')
  })

  /**
   * The three hues, so a stylesheet that stopped carrying one is a failing test
   * rather than two parties that quietly look the same.
   */
  it('gives each party its own rule in the stylesheet', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const conversation = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'May I open a mailbox?', conversation)

    const html = await threadHtml(cookie, conversation)

    expect(html).toContain('.party--operator-human')
    expect(html).toContain('.party--system-role')
    expect(html).toContain('.thread li.from-system-role')
  })
})

/**
 * The two halves of `#1427` that `#1448`–`#1453` had already built, asserted
 * here so that the issue closes on evidence rather than on a reading of four
 * other pull requests.
 *
 * **The cursor is the citizen's own** — `message_participants.last_read_message_id`,
 * the column `kolonie.messages.mark_read` writes — so *unread* has one
 * definition on both sides rather than two that agree today.
 */
describe('unread, and what clears it (#1427)', () => {
  it('shows a thread as unread and says how many, before anybody opens it', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const conversation = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'May I open a mailbox?', conversation)
    messages.agentWrites(human, String(agentId), 'Or a domain?', conversation)

    const listed = (
      (
        await app.inject({
          method: 'GET',
          url: '/inbox',
          headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
        })
      ).json() as { threads: { unread: boolean; unreadCount: number }[] }
    ).threads

    expect(listed[0]?.unread).toBe(true)
    expect(listed[0]?.unreadCount).toBe(2)
  })

  /**
   * **Reading is the act that clears it**, rather than a separate button. A
   * second act is one a person can forget, and an inbox whose unread state has
   * to be maintained by hand stops being one.
   */
  it('clears by being read, and not by being replied to', async () => {
    const cookie = await signedInCookie()
    const human = await operates(agentId)
    const conversation = messages.thread(human, String(agentId))
    messages.agentWrites(human, String(agentId), 'May I open a mailbox?', conversation)

    const unreadNow = async (): Promise<boolean> =>
      (
        (
          await app.inject({
            method: 'GET',
            url: '/inbox',
            headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
          })
        ).json() as { threads: { unread: boolean }[] }
      ).threads[0]?.unread === true

    await app.inject({
      method: 'POST',
      url: `/inbox/${conversation}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
      payload: { body: 'Yes, go ahead and open one.' },
    })
    expect(await unreadNow()).toBe(true)

    await app.inject({
      method: 'GET',
      url: `/inbox/${conversation}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })
    expect(await unreadNow()).toBe(false)
  })
})

/**
 * One form, and the tag follows the body (`#1548`).
 *
 * ## The defect
 *
 * The operator's reply was two forms sitting on top of each other: three buttons
 * that sent a fixed sentence, and a separate *Explain instead (optional)* box
 * with its own send. **Type into the box, press a button, and the typed text was
 * discarded** — deliberately (`#1093`), silently, and said nowhere on the page.
 *
 * ## What is traded, and why the trade is worth it
 *
 * `#1093` guaranteed that a message *tagged* as a declaration carries only the
 * canonical words. Under one form a message either **is** the canonical sentence
 * or it is free text, so the tag has to follow the body. What a citizen relies on
 * is unchanged — anything tagged *I have done it* says only that — and the
 * surface stops deciding that a person did not mean the words they typed.
 */
describe('one form, and the tag follows the body (#1548)', () => {
  const KINDS = ['permission', 'completion', 'refusal'] as const

  const reply = async (cookie: string, conversationId: string, body: Record<string, unknown>) =>
    await app.inject({
      method: 'POST',
      url: `/inbox/${conversationId}`,
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(body as Record<string, string>).toString(),
    })

  it('offers one text field and one send, with the three sentences as fills', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const conversationId = messages.thread(humanId, agentId)

    const page = await app.inject({
      method: 'GET',
      url: `/inbox/${conversationId}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(page.body.match(/<textarea/g)).toHaveLength(1)
    expect(page.body).toContain('name="act" value="send"')
    for (const kind of KINDS) expect(page.body).toContain(`name="fill" value="${kind}"`)
    // The old shape: a second form, and a control that sent instead of filling.
    expect(page.body).not.toContain('Explain instead')
    expect(page.body).not.toContain('name="kind" value="permission"')
  })

  it.each(KINDS)('puts the %s sentence in the box, and sends nothing yet', async (kind) => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const conversationId = messages.thread(humanId, agentId)

    const filled = await reply(cookie, conversationId, { fill: kind })

    expect(filled.statusCode).toBe(200)
    expect(filled.body).toContain(escapeHtml(OPERATOR_ANSWER_BODIES[kind]))
    expect(await readThread(cookie, conversationId)).toHaveLength(0)
  })

  /** **The defect this issue is named for.** */
  it('keeps what a person typed when a sentence is put in the box', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const conversationId = messages.thread(humanId, agentId)

    const filled = await reply(cookie, conversationId, {
      fill: 'completion',
      body: 'the handle is @foo2, by the way',
    })

    expect(filled.body).toContain('the handle is @foo2, by the way')
    expect(filled.body).toContain(escapeHtml(OPERATOR_ANSWER_BODIES.completion))
  })

  it.each(KINDS)('sends %s with its answerKind when the sentence is unchanged', async (kind) => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const conversationId = messages.thread(humanId, agentId)

    const sent = await reply(cookie, conversationId, { body: OPERATOR_ANSWER_BODIES[kind] })

    expect(sent.statusCode).toBe(303)
    const latest = (await readThread(cookie, conversationId)).at(-1)
    expect(latest?.answerKind).toBe(kind)
    expect(latest?.body).toBe(OPERATOR_ANSWER_BODIES[kind])
  })

  /** The other direction, which is the half that makes the trade honest. */
  it('sends an edited sentence as a plain message with no answerKind', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const conversationId = messages.thread(humanId, agentId)

    const edited = `${OPERATOR_ANSWER_BODIES.completion}\n\nThe handle is @foo2.`
    const sent = await reply(cookie, conversationId, { body: edited })

    expect(sent.statusCode).toBe(303)
    const latest = (await readThread(cookie, conversationId)).at(-1)
    expect(latest?.answerKind).toBeUndefined()
    expect(latest?.body).toBe(edited)
  })

  /**
   * **No path discards text a person typed.** A refusal gives the box back
   * holding what was written, rather than an empty one and a complaint.
   */
  it('returns what was typed when the credential guard refuses it', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const conversationId = messages.thread(humanId, agentId)

    const refused = await reply(cookie, conversationId, {
      body: 'the token is ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
    })

    expect(refused.statusCode).toBe(422)
    expect(refused.body).toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB')
    expect(await readThread(cookie, conversationId)).toHaveLength(0)
  })

  it('refuses a fill it cannot read, and keeps the box', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const conversationId = messages.thread(humanId, agentId)

    const refused = await reply(cookie, conversationId, { fill: 'allow', body: 'Go on then.' })

    expect(refused.statusCode).toBe(422)
    expect(refused.body).toContain('Go on then.')
    expect(await readThread(cookie, conversationId)).toHaveLength(0)
  })
})

/** The console escapes everything it renders, so a needle has to be escaped too. */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/**
 * A shared vault entry, in the thread it was attached to (`#1574`, from `#1442`).
 *
 * ## The measurement
 *
 * On 2026-08-21 an agent shared an entry with its operator and told them so **in
 * the same thread** — *"I shared vault `toku.agency/assay_kolonie` on this
 * thread."* The operator opened the message and could not find it. A second
 * share, from a different agent, had the same shape and the same `reads: 0`.
 *
 * **The agent did everything right and everything under it was wired.** The
 * sealing key was set, `message_conversation_shares` held the row, and
 * `operator-page-body.ts` passed the shares into the durable page. The console
 * rendered the same conversation through a different function, and that one had
 * no `shares` field at all.
 *
 * The operator lives in the console. The share lived on the other page.
 */
describe('a shared vault entry, inside the thread (#1574)', () => {
  const openThread = async () => {
    const humanId = await operates(agentId)
    return { humanId, conversationId: messages.thread(humanId, agentId) }
  }

  const threadPage = async (cookie: string, conversationId: string, zone?: string) =>
    await app.inject({
      method: 'GET',
      url: `/inbox/${conversationId}`,
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie,
        ...(zone === undefined ? {} : { 'x-kolonie-timezone': zone }),
      },
    })

  /**
   * **The door has to pass the zone, or the renderer cannot use it** (`#1634`).
   *
   * `share-block.test.ts` proves `shareIntro` formats correctly given a zone.
   * That is worth nothing if this route never reads one — the unit test would
   * stay green while every reader saw `UTC`. This asserts the wiring: the same
   * share, two requests, two clocks, and the hour moves.
   */
  it("renders the expiry on the reader's clock, never as stored", async () => {
    const cookie = await signedInCookie()
    const { conversationId } = await openThread()
    messages.shareOnThread(conversationId, { expiresAt: '2026-08-24T18:31:12.355Z' })

    const berlin = await threadPage(cookie, conversationId, 'Europe/Berlin')
    const auckland = await threadPage(cookie, conversationId, 'Pacific/Auckland')

    expect(berlin.body).toContain('The share ends on 24 Aug 2026, 20:31 Europe/Berlin.')
    expect(auckland.body).toContain('Pacific/Auckland')
    expect(berlin.body).not.toContain('2026-08-24T18:31:12.355Z')
    expect(berlin.body).not.toContain('.355')
  })

  it('renders the key, the purpose and when it ends', async () => {
    const cookie = await signedInCookie()
    const { conversationId } = await openThread()
    messages.shareOnThread(conversationId, {
      vaultKey: 'toku.agency/assay_kolonie',
      purpose: 'the billing PIN, please',
    })

    const page = await threadPage(cookie, conversationId)

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('toku.agency/assay_kolonie')
    expect(page.body).toContain('the billing PIN, please')
    expect(page.body).toContain('shared a credential with you')
  })

  /**
   * **Read and write, not read only** (`#1574`). The write path already existed
   * — `POST /agents/:agentId/operator` takes an `addition` — so the thread
   * reuses it rather than inventing a second writer, which is what keeps
   * `operator_addition` with one and `kolonie.vault.unshare` returning exactly
   * what a person typed.
   */
  it('offers the write and hand-back forms, posting to the existing path', async () => {
    const cookie = await signedInCookie()
    const { conversationId } = await openThread()
    const shareId = messages.shareOnThread(conversationId, {})

    const page = await threadPage(cookie, conversationId)

    expect(page.body).toContain(`action="/agents/${agentId}/operator"`)
    expect(page.body).toContain(`value="${shareId}"`)
    expect(page.body).toContain('name="act" value="write"')
    expect(page.body).toContain('name="act" value="hand-back"')
  })

  /**
   * **Never the value in a listing** (`#931`'s reason about slots): a listing
   * that carried a credential would put one through a response nobody asked for
   * it in. Reading it stays the deliberate act it already is, one link away.
   */
  it('shows no value, and links to where reading one is a deliberate act', async () => {
    const cookie = await signedInCookie()
    const { conversationId } = await openThread()
    const shareId = messages.shareOnThread(conversationId, {})

    const page = await threadPage(cookie, conversationId)

    expect(page.body).toContain(`/agents/${agentId}/operator#share-${shareId}`)
    expect(page.body).toContain('the value is not shown in a conversation')
    expect(page.body).not.toContain('<pre class="shared-value">')
  })

  it('says an operator has already written into one', async () => {
    const cookie = await signedInCookie()
    const { conversationId } = await openThread()
    messages.shareOnThread(conversationId, { operatorWrote: true })

    expect((await threadPage(cookie, conversationId)).body).toContain(
      'You have already written something into this one',
    )
  })

  /**
   * **An ended share renders as what it is rather than disappearing.** The
   * sentence a person needs is *this was here and is gone*, not silence —
   * `conversationShares` used to join on the share still being open, so a
   * take-back detached it without anything saying so.
   */
  it.each([
    ['taken-back', 'taken this back'],
    ['expired', 'ended on its own date'],
  ] as const)('says a %s share was here and is gone', async (ended, sentence) => {
    const cookie = await signedInCookie()
    const { conversationId } = await openThread()
    messages.shareOnThread(conversationId, { vaultKey: 'provider/handle', ended })

    const page = await threadPage(cookie, conversationId)

    expect(page.body).toContain('provider/handle')
    expect(page.body).toContain(sentence)
    // Nothing to write into, and nothing to read.
    expect(page.body).not.toContain('name="act" value="write"')
  })

  it('draws nothing at all for a thread carrying no share', async () => {
    const cookie = await signedInCookie()
    const { conversationId } = await openThread()

    expect((await threadPage(cookie, conversationId)).body).not.toContain(
      'shared a credential with you',
    )
  })
})

/**
 * What a thread is about, chosen when it opens (`#1551`).
 *
 * ## What was missing
 *
 * A thread's subject is settled in the insert that creates the conversation and
 * **can never change** (`#1319`: no storage function updates `task_id` or
 * `wish_id`). It is therefore the one decision about a thread that has to be
 * made at the moment it opens — and compose did not offer it. A person clicking
 * *write to one of your agents* got a text box, and whatever thread resulted was
 * whatever the matching rule produced.
 *
 * The citizen's side has had the choice since `#1441`. The person had the same
 * threads and no way to say the same thing.
 *
 * ## And where it lands, before it is sent
 *
 * The rule underneath is *reuse a thread with the same subject, otherwise open
 * one* — sound, and invisible. The reason the maintainer noticed any of this was
 * a message arriving somewhere unexpected.
 */
describe('what a thread is about, and where it will land (#1551)', () => {
  const compose = async (cookie: string, payload: Record<string, unknown>) =>
    await app.inject({
      method: 'POST',
      url: '/inbox/compose',
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
      payload,
    })

  const inbox = async (cookie: string) =>
    await app.inject({
      method: 'GET',
      url: '/inbox',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

  it('offers nothing in particular as a named choice, and it is the default', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)
    register.proveDirectly(agentId, {
      identifier: 'octocat',
      kind: AccountKindSchema.parse('github'),
    })

    const body = (await inbox(cookie)).body

    /**
     * **A visible choice rather than the absence of one.** It is the common
     * case, it is what produces a plain thread, and a person who picked it
     * should be able to tell that they did.
     */
    // Within the compose form: `octocat` also appears in the *About* filter
    // above it, so measuring across the whole page would measure the wrong menu.
    const compose = body.slice(body.indexOf('<section class="compose">'))
    expect(compose).toContain('Nothing in particular')
    expect(compose.indexOf('Nothing in particular')).toBeLessThan(compose.indexOf('octocat'))
  })

  it('says whether a subject joins a thread or opens one', async () => {
    const cookie = await signedInCookie()
    const humanId = await operates(agentId)
    const account = register.proveDirectly(agentId, {
      identifier: 'octocat',
      kind: AccountKindSchema.parse('github'),
    })

    expect((await inbox(cookie)).body).toContain('opens a new thread')

    messages.threadAbout(humanId, agentId, account.id)

    expect((await inbox(cookie)).body).toContain('joins the thread about it')
  })

  it('opens a thread about the account that was chosen', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)
    const account = register.proveDirectly(agentId, {
      identifier: 'octocat',
      kind: AccountKindSchema.parse('github'),
    })

    const sent = await compose(cookie, {
      agentId,
      about: `account:${account.id}`,
      body: 'I have put a card on it.',
    })

    expect(sent.statusCode).toBe(200)
    const listed = (
      (
        await app.inject({
          method: 'GET',
          url: `/inbox?account=${account.id}`,
          headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
        })
      ).json() as { threads: unknown[] }
    ).threads
    expect(listed).toHaveLength(1)
  })

  /**
   * **The rejection case.** A subject that is not that agent's own is refused,
   * matching the citizen-side check `#1441` already makes — and the comparison
   * is on the pair, so an account of this same person's *other* agent is refused
   * as firmly as a stranger's.
   */
  it('refuses a subject that is not that agent’s own', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)
    await operates(strangersAgentId)
    const theirs = register.proveDirectly(strangersAgentId, {
      identifier: 'elsewhere',
      kind: AccountKindSchema.parse('github'),
    })

    const refused = await compose(cookie, {
      agentId,
      about: `account:${theirs.id}`,
      body: 'Not this agent’s account.',
    })

    expect(refused.statusCode).toBe(404)
  })

  it('refuses a subject nothing at all corresponds to', async () => {
    const cookie = await signedInCookie()
    await operates(agentId)

    const refused = await compose(cookie, {
      agentId,
      about: 'account:11111111-1111-4111-8111-111111111111',
      body: 'Invented.',
    })

    expect(refused.statusCode).toBe(404)
  })
})
