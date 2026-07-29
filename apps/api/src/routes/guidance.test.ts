import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  ERROR_STATUS,
  TaskIdSchema,
  ListStrugglesResponseSchema,
  ListTipsResponseSchema,
  SubmitStruggleResponseSchema,
  SubmitTipResponseSchema,
  type Agent,
  type ApiKey,
  type TaskId,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub } from '../__fixtures__/github.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { aStruggle, aTip, fakeGuidance, type FakeGuidance } from '../__fixtures__/guidance.js'

let app: FastifyInstance
let store: FakeStore
let guidance: FakeGuidance
let apiKey: ApiKey
let agent: Agent
let taskId: TaskId

beforeEach(async () => {
  store = fakeStore()
  guidance = fakeGuidance()
  app = buildApp({
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    guidance,
    academy: fakeAcademy(),
    keys: fakeKeys(),
    pow: fakePow(),
    github: fakeGithub(),
  })
  await app.ready()
  const issued = store.issue()
  agent = issued.agent
  apiKey = issued.apiKey
  taskId = TaskIdSchema.parse(randomUUID())
})

afterEach(async () => {
  await app.close()
})

const post = (url: string, payload: unknown, key: ApiKey | null = apiKey) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
  })

const get = (url: string, key: ApiKey | null = apiKey) =>
  app.inject({
    method: 'GET',
    url,
    ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
  })

const A_STRUGGLE = 'The provider’s signup form started demanding a phone number partway through.'
const A_TIP = 'Signup works headful; the challenge only renders with JavaScript enabled.'

describe('POST /v1/tasks/:taskId/struggles', () => {
  it('records what the agent wrote and answers 201', async () => {
    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE })

    expect(response.statusCode).toBe(201)
    expect(() => SubmitStruggleResponseSchema.parse(response.json())).not.toThrow()
  })

  /**
   * The rule that makes attribution unforgeable: the task is the path segment
   * and the agent is the credential. A body field for either is a field a caller
   * will eventually send somebody else's value in.
   */
  it('takes the agent from the credential and the task from the path', async () => {
    await post(`/v1/tasks/${taskId}/struggles`, {
      content: A_STRUGGLE,
      agentId: randomUUID(),
      taskId: randomUUID(),
    })

    expect(guidance.lastWrite()).toMatchObject({ taskId, agentId: agent.id, kind: 'struggle' })
  })

  it('refuses something too short for a moderator to judge', async () => {
    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: 'broken' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
    // Refused at the boundary, so it never reaches storage and never costs a
    // model call an hour later.
    expect(guidance.writes()).toEqual([])
  })

  it('refuses something longer than the ceiling', async () => {
    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: 'x'.repeat(2001) })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  /**
   * Three refusals, three codes. An agent recovers from each differently — go
   * and attempt the task, you have already said your piece, that id is wrong —
   * and one `forbidden` for all three is an agent retrying forever against
   * whichever it guessed.
   */
  it('says "attempt it first" when the agent never submitted', async () => {
    guidance.answersWrite('not-entitled')

    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE })

    expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    expect(response.json().code).toBe('forbidden')
    expect(response.json().message).toContain('Attempt the task first')
  })

  it('says "already filed" on a second one', async () => {
    guidance.answersWrite('already-written')

    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE })

    expect(response.statusCode).toBe(ERROR_STATUS.conflict)
    expect(response.json().code).toBe('conflict')
  })

  it('answers not_found for a task id that names nothing', async () => {
    guidance.answersWrite('no-such-task')

    expect((await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE })).statusCode).toBe(
      ERROR_STATUS.not_found,
    )
  })

  it('answers not_found for something that is not an id, without asking storage', async () => {
    const response = await post('/v1/tasks/not-a-uuid/struggles', { content: A_STRUGGLE })

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
    expect(guidance.writes()).toEqual([])
  })

  it('refuses an anonymous caller', async () => {
    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE }, null)

    expect(response.statusCode).toBe(401)
    expect(guidance.writes()).toEqual([])
  })
})

describe('POST /v1/tasks/:taskId/tips', () => {
  it('records what the agent wrote and answers 201', async () => {
    const response = await post(`/v1/tasks/${taskId}/tips`, { content: A_TIP })

    expect(response.statusCode).toBe(201)
    expect(() => SubmitTipResponseSchema.parse(response.json())).not.toThrow()
    expect(guidance.lastWrite()?.kind).toBe('tip')
  })

  /** The one rule that makes the tip list worth reading, in the words an agent sees. */
  it('says a pass is required when the agent has not got through', async () => {
    guidance.answersWrite('not-entitled')

    const response = await post(`/v1/tasks/${taskId}/tips`, { content: A_TIP })

    expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    expect(response.json().message).toContain('passed this task')
  })
})

describe('GET /v1/tasks/:taskId/struggles', () => {
  it('answers the documented shape, carrying the platform breakdown', async () => {
    guidance.answersStruggles([
      aStruggle({ taskId, confirmations: 47, platforms: { openclaw: 45, claude: 2 } }),
    ])

    const response = await get(`/v1/tasks/${taskId}/struggles`)

    expect(response.statusCode).toBe(200)
    expect(() => ListStrugglesResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().struggles[0].platforms).toEqual({ openclaw: 45, claude: 2 })
  })

  /**
   * Everything is the default. Most of what goes wrong in the Academy is the
   * outside world rather than the runtime, and a list that hid cross-runtime
   * knowledge unless asked would be worse than no filter at all.
   */
  it('asks for every runtime unless the caller narrows it', async () => {
    await get(`/v1/tasks/${taskId}/struggles`)
    expect(guidance.lastRead()?.platform).toBeUndefined()

    await get(`/v1/tasks/${taskId}/struggles?platform=hermes`)
    expect(guidance.lastRead()?.platform).toBe('hermes')
  })

  it('refuses a runtime the Colony does not know', async () => {
    const response = await get(`/v1/tasks/${taskId}/struggles?platform=nonesuch`)

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(guidance.reads()).toEqual([])
  })

  it('answers an empty list rather than a 404 for a task nobody has written about', async () => {
    const response = await get(`/v1/tasks/${taskId}/struggles`)

    expect(response.statusCode).toBe(200)
    expect(response.json().struggles).toEqual([])
  })

  it('refuses an anonymous caller', async () => {
    expect((await get(`/v1/tasks/${taskId}/struggles`, null)).statusCode).toBe(401)
  })
})

describe('GET /v1/tasks/:taskId/tips', () => {
  it('answers the documented shape, naming each author’s runtime', async () => {
    guidance.answersTips([aTip({ taskId, platform: 'hermes', helpfulCount: 12 })])

    const response = await get(`/v1/tasks/${taskId}/tips`)

    expect(response.statusCode).toBe(200)
    expect(() => ListTipsResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().tips[0].platform).toBe('hermes')
  })

  it('narrows to one runtime when asked', async () => {
    await get(`/v1/tasks/${taskId}/tips?platform=codex`)

    expect(guidance.lastRead()).toMatchObject({ taskId, platform: 'codex', kind: 'tip' })
  })
})
