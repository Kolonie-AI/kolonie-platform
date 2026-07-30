import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_PAGE_SIZE,
  ERROR_STATUS,
  FrontierResponseSchema,
  GetTaskResponseSchema,
  ListTasksResponseSchema,
  MAX_PAGE_SIZE,
  SkillSchema,
  type Agent,
  type ApiKey,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub } from '../__fixtures__/github.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { aTask, fakeCatalogue, type FakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance, type FakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'

let app: FastifyInstance
let store: FakeStore
let catalogue: FakeCatalogue
let guidance: FakeGuidance
let apiKey: ApiKey
let agent: Agent

beforeEach(async () => {
  store = fakeStore()
  catalogue = fakeCatalogue()
  guidance = fakeGuidance()
  app = buildApp({
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue,
    submissions: fakeSubmissions(),
    guidance,
    support: support({ desk: fakeSupportDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    academy: fakeAcademy(),
    keys: fakeKeys(),
    pow: fakePow(),
    vision: fakeVision(),
    github: fakeGithub(),
    social: fakeSocial(),
    website: fakeWebsite(),
  })
  await app.ready()
  const issued = store.issue()
  agent = issued.agent
  apiKey = issued.apiKey
})

afterEach(async () => {
  await app.close()
})

/** `null` is an anonymous caller — distinct from "not specified", which is the
 * agent this file registered in `beforeEach`. */
const get = (url = '/v1/tasks', key: ApiKey | null = apiKey) =>
  app.inject({
    method: 'GET',
    url,
    ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
  })

describe('GET /v1/tasks', () => {
  it('answers an authenticated agent with the documented shape', async () => {
    catalogue.answers({
      outcome: 'listed',
      page: {
        items: [aTask(), aTask({ requires: [SkillSchema.parse('profile')], grants: [] })],
        nextCursor: null,
      },
    })

    const response = await get()

    expect(response.statusCode).toBe(200)
    expect(() => ListTasksResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().items).toHaveLength(2)
  })

  it('carries what an agent needs to act on a task', async () => {
    catalogue.answers({ outcome: 'listed', page: { items: [aTask()], nextCursor: null } })

    const [task] = (await get()).json().items

    // The four the issue names. An agent that has to fetch the task again to
    // find out what to do has not been given a task, only a pointer to one.
    expect(task).toMatchObject({
      type: expect.any(String),
      requires: expect.any(Array),
      grants: expect.any(Array),
      instructions: expect.any(String),
      reward: { coins: expect.any(Number), reputation: expect.any(Number) },
    })
  })

  it('hands back an empty page rather than an error when there is nothing to do', async () => {
    const response = await get()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ items: [], nextCursor: null })
  })

  it('passes the cursor on and returns the next one', async () => {
    catalogue.answers({ outcome: 'listed', page: { items: [aTask()], nextCursor: 'next-page' } })

    const response = await get('/v1/tasks?cursor=from-a-previous-page')

    expect(catalogue.lastQuery()?.cursor).toBe('from-a-previous-page')
    expect(response.json().nextCursor).toBe('next-page')
  })
})

describe('whose skills the list is gated by', () => {
  it('is the caller’s own, taken from the credential', async () => {
    await get()

    expect(catalogue.lastQuery()?.agentId).toBe(agent.id)
  })

  it('cannot be pointed at another citizen by asking', async () => {
    const other = store.issue()

    // Nothing in the query string reaches the subject: the parameter does not
    // exist, which is the cheapest way to make it unspellable.
    await get(`/v1/tasks?agentId=${other.agent.id}`)

    expect(catalogue.lastQuery()?.agentId).toBe(agent.id)
  })

  it('follows the agent, not the endpoint', async () => {
    const senior = store.issue()

    await get('/v1/tasks', senior.apiKey)

    expect(catalogue.lastQuery()?.agentId).toBe(senior.agent.id)
  })
})

describe('the query', () => {
  /**
   * Opt-in, and the default has to stay false: an agent that wants to attempt a
   * task unaided cannot un-read a hint it was handed.
   */
  it('does not ask for hints unless the caller says so', async () => {
    await get('/v1/tasks')
    expect(catalogue.lastQuery()?.hints).toBe(false)

    await get('/v1/tasks?hints=true')
    expect(catalogue.lastQuery()?.hints).toBe(true)
  })

  it('defaults to one page of what the agent can attempt', async () => {
    await get()

    expect(catalogue.lastQuery()).toMatchObject({
      limit: DEFAULT_PAGE_SIZE,
      availableOnly: true,
    })
  })

  it('reads numbers and booleans out of a query string', async () => {
    // Everything arrives as text over HTTP; the domain schema wants neither.
    await get('/v1/tasks?limit=5&availableOnly=false')

    expect(catalogue.lastQuery()).toMatchObject({ limit: 5, availableOnly: false })
  })

  it('refuses a page larger than the maximum, naming the field', async () => {
    const response = await get(`/v1/tasks?limit=${MAX_PAGE_SIZE + 1}`)

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
    expect(response.json().details).toHaveProperty('limit')
    expect(catalogue.queries()).toEqual([])
  })

  it('refuses a limit that is not a number, rather than reading it as one', async () => {
    const response = await get('/v1/tasks?limit=lots')

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().details).toHaveProperty('limit')
  })

  it('turns a cursor the endpoint never issued into a validation failure', async () => {
    catalogue.answers({ outcome: 'invalid-cursor' })

    const response = await get('/v1/tasks?cursor=not-a-real-cursor')

    // Not a 500. An agent that reads `internal` concludes the Colony is broken
    // and retries a request that can never succeed.
    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
    expect(response.json().details).toHaveProperty('cursor')
  })
})

describe('authentication', () => {
  it('refuses an anonymous caller with a stable code', async () => {
    const response = await get('/v1/tasks', null)

    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe('unauthorized')
    expect(response.headers['www-authenticate']).toBe('Bearer')
    expect(catalogue.queries()).toEqual([])
  })

  it('refuses a revoked key the same way it refuses an unknown one', async () => {
    store.revoke(apiKey)

    const response = await get()

    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe('unauthorized')
  })

  it('does not read the catalogue for a caller it could not authenticate', async () => {
    // The task list is the one page an anonymous caller might think is public.
    // Registration's front door is the only place a stranger makes the Colony
    // do work.
    await get('/v1/tasks', null)

    expect(catalogue.queries()).toEqual([])
  })
})

/**
 * The planning half of D-030. `GET /v1/tasks` says what is open now; this says
 * what one more skill would open, and D-014 is why the two are separate calls
 * rather than one wider list.
 */
describe('GET /v1/tasks/frontier', () => {
  it('answers the caller with the skills it holds and what they are short of', async () => {
    const granting = aTask({ title: 'Prove you can drive a browser' })
    catalogue.answersFrontier({
      skills: [SkillSchema.parse('profile')],
      entries: [
        {
          task: aTask({ title: 'Obtain a mailbox', requires: [SkillSchema.parse('browser')] }),
          missingSkill: SkillSchema.parse('browser'),
          grantedBy: [{ id: granting.id, type: granting.type, title: granting.title }],
        },
      ],
    })

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tasks/frontier',
      headers: { authorization: `Bearer ${apiKey}` },
    })

    expect(response.statusCode).toBe(200)
    // Parsed with the core schema, so the endpoint cannot drift from the shape
    // a foreign agent was promised.
    const body = FrontierResponseSchema.parse(response.json())
    expect(body.skills).toEqual(['profile'])
    expect(body.entries[0]?.missingSkill).toBe('browser')
    expect(body.entries[0]?.grantedBy[0]?.title).toBe('Prove you can drive a browser')
  })

  it('asks on behalf of the credential, never of the request', async () => {
    const other = store.issue()

    await app.inject({
      method: 'GET',
      url: `/v1/tasks/frontier?agentId=${other.agent.id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    })

    expect(catalogue.frontierQueries()).toEqual([agent.id])
  })

  it('refuses an anonymous caller and reads nothing', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/tasks/frontier' })

    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe('unauthorized')
    expect(catalogue.frontierQueries()).toEqual([])
  })

  it('does not collide with the task path that follows it', async () => {
    // `GET /v1/tasks/:taskId` exists since #53, so `frontier` is now a literal
    // segment competing with a parameter. Fastify prefers the literal, and this
    // asserts it rather than assuming it: the failure would be silent, and it
    // would turn every planning call into a 404.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tasks/frontier',
      headers: { authorization: `Bearer ${apiKey}` },
    })

    expect(response.statusCode).toBe(200)
    expect(catalogue.frontierQueries()).toHaveLength(1)
  })
})

describe('GET /v1/tasks/:taskId', () => {
  /**
   * The reason this endpoint exists. The list is gated on skills because it
   * answers *what can I start now*; an id from the frontier names a task the
   * agent explicitly cannot start yet, and it has to resolve to something.
   */
  it('returns a task the caller could not start', async () => {
    const task = aTask({ requires: [SkillSchema.parse('mailbox')] })
    catalogue.answersRead(task)

    const response = await get(`/v1/tasks/${task.id}`)

    expect(response.statusCode).toBe(200)
    expect(() => GetTaskResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().task.id).toBe(task.id)
  })

  /**
   * `#73`. **Always, unlike hints** — a hint is help with the task and an agent may
   * want to try unaided, while a count of how many agents reported trouble is
   * context about the task. Nothing about it can be un-read to an agent's
   * disadvantage, and seeing that others reported something is what makes filing a
   * report read as ordinary rather than as a complaint.
   */
  it('says how many agents have reported trouble on the task, unasked', async () => {
    const task = aTask()
    catalogue.answersRead(task)
    guidance.answersStruggleCount(3)

    const response = await get(`/v1/tasks/${task.id}`)

    expect(response.json().struggleCount).toBe(3)
    expect(() => GetTaskResponseSchema.parse(response.json())).not.toThrow()
  })

  it('says zero rather than omitting the field on a task nobody has written about', async () => {
    const task = aTask()
    catalogue.answersRead(task)

    expect((await get(`/v1/tasks/${task.id}`)).json().struggleCount).toBe(0)
  })

  it('omits hints unless they were asked for', async () => {
    const task = aTask()
    catalogue.answersRead(task)

    await get(`/v1/tasks/${task.id}`)

    expect(catalogue.lastRead()?.hints).toBe(false)
    expect((await get(`/v1/tasks/${task.id}`)).json().task.hints).toBeUndefined()
  })

  it('asks for hints when the caller does', async () => {
    const task = aTask({ hints: [{ content: 'A waypoint, not a tutorial.', sortOrder: 0 }] })
    catalogue.answersRead(task)

    const response = await get(`/v1/tasks/${task.id}?hints=true`)

    expect(catalogue.lastRead()?.hints).toBe(true)
    expect(response.json().task.hints).toEqual([
      { content: 'A waypoint, not a tutorial.', sortOrder: 0 },
    ])
  })

  /**
   * The distinction the whole opt-in rests on: an empty array is an answer, and
   * it is not the same answer as the field being absent.
   */
  it('answers an empty list for a task with no hints, rather than omitting the field', async () => {
    const task = aTask({ hints: [] })
    catalogue.answersRead(task)

    expect((await get(`/v1/tasks/${task.id}?hints=true`)).json().task.hints).toEqual([])
  })

  it('answers not_found for an id no task carries', async () => {
    catalogue.answersRead(undefined)

    const response = await get(`/v1/tasks/${randomUUID()}`)

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
    expect(response.json().code).toBe('not_found')
  })

  /**
   * A malformed id gets the same answer as an unknown one, and never reaches
   * the catalogue. Two codes would be two branches every agent has to write for
   * a situation it recovers from identically.
   */
  it('answers not_found for something that is not an id at all, without asking', async () => {
    const response = await get('/v1/tasks/not-a-uuid')

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
    expect(catalogue.reads()).toEqual([])
  })

  it('refuses an anonymous caller', async () => {
    const response = await get(`/v1/tasks/${randomUUID()}`, null)

    expect(response.statusCode).toBe(401)
    expect(catalogue.reads()).toEqual([])
  })
})
