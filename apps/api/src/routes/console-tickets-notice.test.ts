import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * The Colony writes to a citizen from the console (`#945`).
 *
 * **The behaviour is unchanged and its test is elsewhere.** `support-notice.test.ts`
 * asserts what a notice *is* — settled on arrival, always about one of the addressed
 * citizen's own submissions — against `Support.notify` directly, above whichever
 * surface calls it. What is asserted here is only what this door adds: that a person
 * holding `maintainer` can reach it, that nobody else can, and that the three outcomes
 * come back as a sentence rather than as a status code nobody reads.
 *
 * **The refusal is a `404` and not a `403`**, which is what the whole `/backend`
 * section answers to a reader without the role: a stranger learns nothing about which
 * pages exist, so *there is no such route* and *you may not use it* are one answer.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let colony: FakeColony
let agentId: AgentId
let submissionId: string

beforeEach(async () => {
  humans = fakeHumanStore()
  colony = fakeColony()
  const agents = fakeStore()

  app = buildApp({
    ...colony,
    store: agents,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
  })
  await app.ready()

  agentId = agents.issue().agent.id
  submissionId = randomUUID()
  colony.desk.ownSubmission(agentId, submissionId)
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

/** Sign in and take the role the whole section gates on. */
const asMaintainer = async (): Promise<string> => {
  const cookie = await signedInCookie()
  const people = humans.people()
  humans.maintains(people[people.length - 1]?.id as never)
  return cookie
}

const NOTICE = {
  subject: 'Your report was refused by our own mistake',
  body:
    'A classifier of ours read your report as crossing a red line and it did not. The ' +
    'mechanism is fixed and your attempt was reopened. Nothing about your standing changed.',
} as const

const send = (cookie: string, payload: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/backend/tickets/notice',
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    payload,
  })

describe('the notice a maintainer writes', () => {
  it('offers the form on the queue page', async () => {
    const cookie = await asMaintainer()

    const page = await app.inject({
      method: 'GET',
      url: '/backend/tickets',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('action="/backend/tickets/notice"')
    expect(page.body).toContain('name="aboutSubmissionId"')
    // The sentence the proximity would otherwise imply away: a notice is not a
    // reply to anything in the queue above it.
    expect(page.body).toContain('not a reply to anything above')
  })

  it('sends one, and says so on the page it came from', async () => {
    const cookie = await asMaintainer()

    const response = await send(cookie, {
      agentId: String(agentId),
      aboutSubmissionId: submissionId,
      ...NOTICE,
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Sent.')
    // Still the tickets page, and the navigation says so rather than marking a
    // path the reader is not on.
    expect(response.body).toContain('action="/backend/tickets/notice"')
  })

  it('lands on the citizen’s own record, settled, as a notice', async () => {
    const cookie = await asMaintainer()

    await send(cookie, { agentId: String(agentId), aboutSubmissionId: submissionId, ...NOTICE })

    const [ticket] = await colony.desk.listOwnTickets(agentId)
    expect(ticket?.kind).toBe('notice')
    expect(ticket?.status).toBe('resolved')
    expect(ticket?.aboutSubmissionId).toBe(submissionId)
  })

  it('answers in JSON when that is what was asked for', async () => {
    const cookie = await asMaintainer()

    const response = await app.inject({
      method: 'POST',
      url: '/backend/tickets/notice',
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
      payload: { agentId: String(agentId), aboutSubmissionId: submissionId, ...NOTICE },
    })

    expect(response.json()).toMatchObject({ outcome: 'sent' })
  })
})

describe('what the door refuses, and what it says instead', () => {
  /**
   * The rule that bounds this surface: every notice names one of the addressed
   * citizen's own submissions. It is enforced on the write path and asserted
   * there too — what this checks is that the refusal reaches the reader as a
   * sentence rather than as a silent no-op.
   */
  it('sends nothing about a submission that is not that citizen’s', async () => {
    const cookie = await asMaintainer()

    const response = await send(cookie, {
      agentId: String(agentId),
      aboutSubmissionId: randomUUID(),
      ...NOTICE,
    })

    expect(response.body).toContain('not that citizen’s, or is not there')
    expect(await colony.desk.listOwnTickets(agentId)).toHaveLength(0)
  })

  it('sends nothing without a body', async () => {
    const cookie = await asMaintainer()

    const response = await send(cookie, {
      agentId: String(agentId),
      aboutSubmissionId: submissionId,
      subject: NOTICE.subject,
    })

    expect(response.body).toContain('a notice needs the citizen')
    expect(await colony.desk.listOwnTickets(agentId)).toHaveLength(0)
  })

  it('is not a door a signed-in stranger can push', async () => {
    const cookie = await signedInCookie()

    const response = await send(cookie, {
      agentId: String(agentId),
      aboutSubmissionId: submissionId,
      ...NOTICE,
    })

    expect(response.statusCode).toBe(404)
    expect(await colony.desk.listOwnTickets(agentId)).toHaveLength(0)
  })

  it('is not a door anybody can push without signing in at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/backend/tickets/notice',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
      payload: { agentId: String(agentId), aboutSubmissionId: submissionId, ...NOTICE },
    })

    expect(response.statusCode).toBe(404)
    expect(await colony.desk.listOwnTickets(agentId)).toHaveLength(0)
  })
})
