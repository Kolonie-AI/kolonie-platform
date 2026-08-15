import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AccountKindSchema, type AgentId } from '@kolonie-ai/core'
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
import {
  fakeAccountRegister,
  fakeAccounts,
  type FakeAccountRegister,
} from '../__fixtures__/accounts.js'
import { fakeAccountThreads, type FakeAccountThreads } from '../__fixtures__/account-threads.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * The account is the page (`#932`).
 *
 * `#928` gave the operator a list and the list stops where their next question
 * starts: *what is going on with this one, and whose move is it?* These assert
 * the routes rather than the HTML — the renderer is covered beside itself in
 * `console/account-thread.test.ts` — so what is under test here is who the page
 * answers, what each form writes, and that the two writes are separate acts.
 *
 * **Two fakes, one account.** The head is read from the register and the thread
 * from the thread store, which in production are one row reached by two queries.
 * Both fakes are given the register's id so the test cannot pass against halves
 * that would never meet.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let colony: FakeColony
let register: FakeAccountRegister
let threads: FakeAccountThreads
let agentId: AgentId
let strangersAgentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  const pages = fakeOperatorPages()
  const agents = fakeStore()
  colony = fakeColony()
  register = fakeAccountRegister()
  threads = fakeAccountThreads()

  app = buildApp({
    ...colony,
    accounts: fakeAccounts(register),
    accountThreads: threads,
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

const link = async (id: AgentId): Promise<void> => {
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, human.id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
}

/** One account on both fakes, under the register's id. RFC 2606 hostnames (§3). */
const heldAccount = (id: AgentId): { readonly id: string } => {
  const account = register.proveDirectly(id, {
    kind: AccountKindSchema.parse('mailbox'),
    identifier: 'ariadne@mail.example',
    provider: 'mail.example',
  })
  threads.addAccount({
    agentId: id,
    id: account.id,
    kind: 'mailbox',
    identifier: 'ariadne@mail.example',
    provider: 'mail.example',
  })
  return { id: account.id }
}

const openConversation = async (accountId: string, turn: 'agent' | 'operator' = 'operator') => {
  const thread = await threads.thread(accountId)
  if (thread === undefined) throw new Error('no thread')
  const opened = await threads.openEpisode({
    threadId: thread.id,
    openedBy: 'agent',
    kind: 'maintenance',
    title: 'The mailbox at mail.example stopped answering',
    turn,
  })
  if (opened.outcome !== 'opened') throw new Error(opened.outcome)
  return { thread, episode: opened.episode }
}

const page = (cookie: string, id: AgentId, accountId: string) =>
  app.inject({
    method: 'GET',
    url: `/agents/${String(id)}/accounts/${accountId}`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
  })

describe('one account, and everything said about it', () => {
  it('names the account and carries what either side wrote', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const account = heldAccount(agentId)
    const { episode } = await openConversation(account.id)
    await threads.writeEntry({
      episodeId: episode.id,
      author: 'agent',
      body: 'The provider stopped accepting the password.',
    })

    const response = await page(cookie, agentId, account.id)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('ariadne@mail.example')
    expect(response.body).toContain('The provider stopped accepting the password.')
    expect(response.body).toContain('Waiting on you')
  })

  /**
   * **The rejection case.** An operator who does not operate this agent gets the
   * console's 404 — the same answer as an id that names nothing — because a
   * different one would make the page a way to test whether an account exists.
   */
  it('answers a person who does not operate the agent exactly as a missing page does', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const theirs = heldAccount(strangersAgentId)

    const response = await page(cookie, strangersAgentId, theirs.id)
    const nothing = await page(cookie, agentId, '00000000-0000-4000-8000-000000000000')

    expect(response.statusCode).toBe(404)
    expect(response.statusCode).toBe(nothing.statusCode)
    expect(response.body).not.toContain('ariadne@mail.example')
  })

  /**
   * The same 404 for an account that is real and belongs to somebody else. The
   * authorisation is held at the read — the register is asked for *this agent's*
   * accounts — so there is no second check here to get wrong.
   */
  it('does not show an account held by another agent', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    heldAccount(agentId)
    const theirs = heldAccount(strangersAgentId)

    const response = await page(cookie, agentId, theirs.id)

    expect(response.statusCode).toBe(404)
  })

  it('is not reachable without a session at all', async () => {
    const account = heldAccount(agentId)

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${String(agentId)}/accounts/${account.id}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })

  it('adds no JavaScript', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const account = heldAccount(agentId)
    await openConversation(account.id)

    const response = await page(cookie, agentId, account.id)

    expect(response.body).not.toMatch(/<script\b/)
    expect(response.body).not.toMatch(/ on[a-z]+="/)
  })
})

describe('what the operator can write', () => {
  /**
   * **Writing is not taking the ball.** An operator saying *I have asked the
   * provider and I am waiting* has not undertaken the next move, and a page that
   * moved the turn for them would quietly make the agent stop.
   */
  it('writes a note without moving the turn', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const account = heldAccount(agentId)
    const { episode } = await openConversation(account.id, 'agent')

    const written = await app.inject({
      method: 'POST',
      url: `/agents/${String(agentId)}/accounts/${account.id}/note`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      payload: { conversation: String(episode.id), body: 'I have asked the provider.' },
    })

    expect(written.statusCode).toBe(303)
    expect(written.headers['location']).toBe(
      `/agents/${String(agentId)}/accounts/${account.id}?said=note`,
    )

    const entries = await threads.entries(episode.id)
    expect(entries.map((entry) => entry.body)).toContain('I have asked the provider.')
    const [after] = await threads.episodes(episode.threadId)
    expect(after?.turn).toBe('agent')
  })

  it('passes the turn as an act of its own', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const account = heldAccount(agentId)
    const { episode } = await openConversation(account.id, 'operator')

    const passed = await app.inject({
      method: 'POST',
      url: `/agents/${String(agentId)}/accounts/${account.id}/turn`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      payload: { conversation: String(episode.id), to: 'agent' },
    })

    expect(passed.statusCode).toBe(303)
    const [after] = await threads.episodes(episode.threadId)
    expect(after?.turn).toBe('agent')
    expect(await threads.entries(episode.id)).toHaveLength(0)
  })

  /**
   * `#582`: the title is composed from the kind and the provider and never from
   * the identifier, so a mailbox address does not end up in a heading that is
   * read out, quoted in a digest and carried into the Atlas.
   */
  it('opens a conversation titled by kind and provider, never by the identifier', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const account = heldAccount(agentId)

    const opened = await app.inject({
      method: 'POST',
      url: `/agents/${String(agentId)}/accounts/${account.id}/open`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      payload: { reason: 'wrong' },
    })

    expect(opened.statusCode).toBe(303)
    const thread = await threads.thread(account.id)
    const [episode] = await threads.episodes(thread?.id as never)
    expect(episode?.title).toContain('mail.example')
    expect(episode?.title).not.toContain('ariadne@mail.example')
    // Opened by the operator and handed straight to the agent: the point of the
    // button is that somebody else now has the move.
    expect(episode?.openedBy).toBe('operator')
    expect(episode?.turn).toBe('agent')
  })

  /**
   * A form aimed at a conversation on somebody else's account writes nothing and
   * says the same thing as one that closed a second ago — the four states are
   * deliberately indistinguishable from outside (`SLOT_CLOSED_NOTICE`'s reason).
   */
  it('writes nothing into a conversation on another agent’s account', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const mine = heldAccount(agentId)
    const theirs = heldAccount(strangersAgentId)
    const { episode } = await openConversation(theirs.id)

    const written = await app.inject({
      method: 'POST',
      url: `/agents/${String(agentId)}/accounts/${mine.id}/note`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      payload: { conversation: String(episode.id), body: 'not mine to write on' },
    })

    expect(written.statusCode).toBe(303)
    expect(written.headers['location']).toBe(`/agents/${String(agentId)}/accounts/${mine.id}`)
    expect(await threads.entries(episode.id)).toHaveLength(0)
  })
})
