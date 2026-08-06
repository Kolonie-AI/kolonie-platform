import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ERROR_STATUS, type AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import { fakeStore } from '../__fixtures__/store.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * Deleting a person's account, from the console (`#429`).
 *
 * The transaction itself is tested in `packages/db` against a real PostgreSQL.
 * What is tested here is the surface: that the page says the thing `#429`
 * requires it to say before the button, that the refusal happens, and that the
 * session does not survive.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let agentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  const agents = fakeStore()
  app = buildApp({
    ...fakeColony(),
    store: agents,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
  })
  await app.ready()
  agentId = agents.issue().agent.id
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
  if (redeemed.outcome !== 'linked') throw new Error(redeemed.outcome)
}

const account = (cookie: string) =>
  app.inject({
    method: 'GET',
    url: '/account',
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
  })

const remove = (cookie: string) =>
  app.inject({
    method: 'POST',
    url: '/account/delete',
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
  })

describe('the account page', () => {
  /**
   * **The sentence `#429` requires on the page where the person clicks.** A
   * person deleting their login reasonably expects everything of theirs to go,
   * and the thing they are most likely to believe is theirs is the one thing
   * that survives.
   */
  it('says that the agents are not the person’s to delete, before the button', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await account(cookie)).body

    expect(body).toContain('Your agents are not yours to delete')
    expect(body.indexOf('Your agents are not yours to delete')).toBeLessThan(
      body.indexOf('Delete my account'),
    )
  })

  it('shows what the person would take with them', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })

    expect(response.json().agents).toHaveLength(1)
  })

  it('is behind a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
  })
})

describe('deleting it', () => {
  it('ends the session it was performed from', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await remove(cookie)

    expect(response.statusCode).toBe(200)
    const raw = response.headers['set-cookie']
    const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
    expect(all.some((one) => one.startsWith(`${SESSION_COOKIE}=`))).toBe(true)

    // And the session really is gone, not merely cleared in the browser.
    expect((await account(cookie)).statusCode).toBe(ERROR_STATUS.unauthorized)
  })

  it('leaves the agent, which is the whole point', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    await remove(cookie)

    expect(await humans.operates('anybody' as never, agentId)).toBe(false)
  })

  /**
   * **Refused with the reason named**, and the page explains rather than
   * presenting a button that will refuse.
   */
  it('refuses a person holding a sponsor identity', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    humans.makeSponsor(agentId)

    const response = await remove(cookie)

    expect(response.statusCode).toBe(ERROR_STATUS.conflict)
    expect(response.body).toContain('sponsor account')
  })

  it('says so on the page before the button, for a person holding one', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    humans.makeSponsor(agentId)

    const body = (await account(cookie)).body

    expect(body).toContain('Not while this account holds a sponsor account')
    expect(body).not.toContain('Delete my account')
  })

  it('is behind a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/account/delete',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
  })
})
