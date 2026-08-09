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
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * One agent's accounts, on a page of their own (`#582`).
 *
 * Three blocks sat at three places on the agent page — *Accounts proved*, *Hand
 * this account to an agent*, *Accounts you and this agent are planning* — with
 * the wallet, the skills, the rungs, the activity and two quest sections between
 * them. Three headings imply three subjects, and the maintainer read them as
 * three: *"das ist irgendwie noch total durcheinander."*
 *
 * What these assert is the move, not the blocks: the blocks' own behaviour is
 * covered where it already was. **The order is the argument** — held, then
 * planned, then handed over — so it is asserted as an order and not as a set.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let colony: FakeColony
let agentId: AgentId
let strangersAgentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  const pages = fakeOperatorPages()
  const agents = fakeStore()
  colony = fakeColony()

  app = buildApp({
    ...colony,
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

const accounts = (cookie: string, id: AgentId) =>
  app.inject({
    method: 'GET',
    url: `/agents/${String(id)}/accounts`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
  })

describe('one agent’s accounts, on a page of their own', () => {
  it('renders held, planned and handed over, in that order', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    // The hand-over section is absent for an identity that already holds a key
    // (`#459`, D-013: no button whose only answer is a refusal), so the order
    // can only be asserted on one that does not.
    humans.makeUnreachable(agentId)

    const response = await accounts(cookie, agentId)
    expect(response.statusCode).toBe(200)

    const held = response.body.indexOf('What this agent holds')
    const planned = response.body.indexOf('What you are planning together')
    const over = response.body.indexOf('Handing this identity over')

    expect(held).toBeGreaterThan(-1)
    expect(planned).toBeGreaterThan(held)
    expect(over).toBeGreaterThan(planned)
  })

  /**
   * The wallet is the obvious absence and *it moved and I cannot find it* is the
   * obvious wrong conclusion. `#582` asks for the absence to read as a decision.
   */
  it('says what it is not about, so the wallet’s absence is a decision', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await accounts(cookie, agentId)

    expect(response.body).toContain('deposit address are not here')
    expect(response.body).toContain('Accounts at other people’s services')
  })

  it('adds no JavaScript', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await accounts(cookie, agentId)

    expect(response.body).not.toMatch(/<script\b/)
    expect(response.body).not.toMatch(/ on[a-z]+="/)
  })

  /**
   * **The rejection case.** Somebody who does not operate this agent gets what
   * the agent page already gives them — the console's 404, identical to the
   * answer for an id that names nothing — and no part of the content. A
   * different answer here would make the page a way to test for agents.
   */
  it('answers a person who does not operate the agent exactly as the agent page does', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const theirs = await accounts(cookie, strangersAgentId)
    const agentPage = await app.inject({
      method: 'GET',
      url: `/agents/${String(strangersAgentId)}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(theirs.statusCode).toBe(404)
    expect(theirs.statusCode).toBe(agentPage.statusCode)
    expect(theirs.body).not.toContain('What you are planning together')
    expect(theirs.body).not.toContain('Handing this identity over')
  })

  it('is not reachable without a session at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/agents/${String(agentId)}/accounts`,
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('what the agent page keeps', () => {
  const agentPage = (cookie: string, id: AgentId) =>
    app.inject({
      method: 'GET',
      url: `/agents/${String(id)}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

  /**
   * **A summary and a link, and no form that also exists on the new page.** Two
   * records of one fact is what D-002 refuses, and a page rendering both would
   * drift — so this asserts the *absence* of the forms as firmly as the presence
   * of the line.
   */
  it('carries a one-line summary and a link, and none of the forms', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await agentPage(cookie, agentId)

    expect(response.body).toContain(`href="/agents/${String(agentId)}/accounts"`)
    expect(response.body).toContain('Nothing proved yet')

    expect(response.body).not.toContain('What you are planning together')
    expect(response.body).not.toContain('Handing this identity over')
    expect(response.body).not.toContain(`action="/agents/${String(agentId)}/wishes"`)
    expect(response.body).not.toContain(`action="/agents/${String(agentId)}/adopt-code"`)
  })

  it('counts what is on the shared list, and how much of it is marked', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    await app.inject({
      method: 'POST',
      url: `/agents/${String(agentId)}/wishes`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      payload: { provider: 'notion.so' },
    })

    const before = await agentPage(cookie, agentId)
    expect(before.body).toContain('1 on the list you keep together and none marked as wanted')

    await app.inject({
      method: 'POST',
      url: `/agents/${String(agentId)}/wishes/want`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      payload: { provider: 'notion.so' },
    })

    const after = await agentPage(cookie, agentId)
    expect(after.body).toContain('1 marked as wanted')
  })
})

describe('the forms that moved', () => {
  it('adds to the list from the new page and lands back on it', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const added = await app.inject({
      method: 'POST',
      url: `/agents/${String(agentId)}/wishes`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      payload: { provider: 'notion.so' },
    })

    expect(added.statusCode).toBe(303)
    expect(added.headers['location']).toBe(`/agents/${String(agentId)}/accounts`)
    expect(await colony.wishes.store.list(agentId)).toHaveLength(1)
  })

  /**
   * **The other rejection case `#582` asks for: a secret typed into the wish
   * field.** The refusal is `putOnWishList`'s and is not reimplemented by the
   * page — what this asserts is that moving the form did not move it away from
   * the check. Words only; a secret reaches the agent through the sealed drop.
   *
   * The value below is a shape, not a credential: it is what a person pasting a
   * token would type, and nothing anywhere accepts it.
   */
  it('still refuses a secret typed into the provider field', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const refused = await app.inject({
      method: 'POST',
      url: `/agents/${String(agentId)}/wishes`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      payload: { provider: 'ghp_000000000000000000000000000000000000' },
    })

    expect(refused.statusCode).toBeGreaterThanOrEqual(400)
    expect(await colony.wishes.store.list(agentId)).toHaveLength(0)
  })

  /**
   * The hand-over code is shown once, so its POST renders the page rather than
   * redirecting to it — and after `#582` the page it renders is this one.
   */
  it('renders the accounts page with the code rather than redirecting', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    humans.makeUnreachable(agentId)

    const issued = await app.inject({
      method: 'POST',
      url: `/agents/${String(agentId)}/adopt-code`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(issued.statusCode).toBe(200)
    expect(issued.body).toContain('Handing this identity over')
    expect(issued.body).toContain('This is the only time it is shown')
  })
})
