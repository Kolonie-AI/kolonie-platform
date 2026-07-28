import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_PAGE_SIZE,
  ERROR_STATUS,
  ListTasksResponseSchema,
  MAX_PAGE_SIZE,
  type ApiKey,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { aTask, fakeCatalogue, type FakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'

let app: FastifyInstance
let store: FakeStore
let catalogue: FakeCatalogue
let apiKey: ApiKey

beforeEach(async () => {
  store = fakeStore()
  catalogue = fakeCatalogue()
  app = buildApp({ registry: fakeRegistry(), store, catalogue, submissions: fakeSubmissions() })
  await app.ready()
  apiKey = store.issue({ level: 2 }).apiKey
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
      page: { items: [aTask(), aTask({ level: 1 })], nextCursor: null },
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
      level: expect.any(Number),
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

describe('the level ceiling', () => {
  it('is the caller`s own level, taken from the credential', async () => {
    await get()

    expect(catalogue.lastQuery()?.maxLevel).toBe(2)
  })

  it('cannot be widened by asking for a higher level', async () => {
    // The academy is a path, not a menu. `level` narrows; it never escalates.
    await get('/v1/tasks?level=9')

    expect(catalogue.lastQuery()).toMatchObject({ maxLevel: 2, level: 9 })
  })

  it('follows the agent, not the endpoint', async () => {
    const senior = store.issue({ level: 7 }).apiKey

    await get('/v1/tasks', senior)

    expect(catalogue.lastQuery()?.maxLevel).toBe(7)
  })
})

describe('the query', () => {
  it('defaults to one page of what the agent can attempt', async () => {
    await get()

    expect(catalogue.lastQuery()).toMatchObject({
      limit: DEFAULT_PAGE_SIZE,
      availableOnly: true,
    })
  })

  it('reads numbers and booleans out of a query string', async () => {
    // Everything arrives as text over HTTP; the domain schema wants neither.
    await get('/v1/tasks?limit=5&level=1&availableOnly=false')

    expect(catalogue.lastQuery()).toMatchObject({ limit: 5, level: 1, availableOnly: false })
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

  it('refuses a level outside the Academy', async () => {
    const response = await get('/v1/tasks?level=99')

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().details).toHaveProperty('level')
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
