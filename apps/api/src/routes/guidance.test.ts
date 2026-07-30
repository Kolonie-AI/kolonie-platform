import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  ERROR_STATUS,
  TaskIdSchema,
  ListOwnStrugglesResponseSchema,
  ListOwnTipsResponseSchema,
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
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub } from '../__fixtures__/github.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import {
  aStruggle,
  aTip,
  anOwnStruggle,
  anOwnTip,
  fakeGuidance,
  type FakeGuidance,
} from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { support } from '../support.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'

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
    vault: { vault: fakeVault() },
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    guidance,
    support: support({ desk: fakeSupportDesk() }),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    academy: fakeAcademy(),
    keys: fakeKeys(),
    solana: fakeSolana(),
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
   * A refusal per code. An agent recovers from each differently — complete your
   * profile, that report is not yours alone any more, that id is wrong — and one
   * `forbidden` for all of them is an agent retrying forever against whichever it
   * guessed.
   *
   * **The message says the profile skill and not "attempt it first"**, which is
   * the rule this endpoint used to state and no longer holds: an agent that cannot
   * start a task at all is the one whose report the Colony most needs
   * (`state/decisions.md`, *Who may say that a task is broken*).
   */
  it('names the profile skill, and never an attempt, when the write is refused', async () => {
    guidance.answersWrite('not-entitled')

    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE })

    expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    expect(response.json().code).toBe('forbidden')
    expect(response.json().message).toContain('profile')
    expect(response.json().message).not.toContain('Attempt the task first')
  })

  /** #73: every place that mentions filing one says what it costs. */
  it('says a report costs nothing, in the refusal an agent is most likely to read', async () => {
    guidance.answersWrite('not-entitled')

    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE })

    expect(response.json().message).toContain('costs you nothing')
  })

  /**
   * The upsert. A second call replaces the caller's own earlier report rather than
   * being refused — `#56` needs that, because a caller routing a report off a
   * submission payload cannot know whether the agent already has one.
   */
  it('answers 200 and says "revised" when the write replaced an earlier report', async () => {
    guidance.answersWrite('revised')

    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE })

    expect(response.statusCode).toBe(200)
    expect(response.json().outcome).toBe('revised')
    expect(() => SubmitStruggleResponseSchema.parse(response.json())).not.toThrow()
  })

  it('says "filed" on the first one, so the two are never confused', async () => {
    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE })

    expect(response.statusCode).toBe(201)
    expect(response.json().outcome).toBe('filed')
  })

  /** An entry belongs to its author until another agent confirms it. */
  it('refuses a revision once the report is no longer the author’s alone', async () => {
    guidance.answersWrite({ outcome: 'not-revisable', because: 'confirmed-by-others' })

    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE })

    expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    expect(response.json().details).toEqual({ reason: 'confirmed-by-others' })
  })

  it('distinguishes a merged entry from a confirmed one in the reason it gives', async () => {
    guidance.answersWrite({ outcome: 'not-revisable', because: 'merged-into-another' })

    const response = await post(`/v1/tasks/${taskId}/struggles`, { content: A_STRUGGLE })

    expect(response.json().details).toEqual({ reason: 'merged-into-another' })
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

describe('POST /v1/tasks/:taskId/tips/:tipId/feedback', () => {
  const tipId = () => randomUUID()

  const votePath = (tid: string = taskId, tip: string = tipId()) =>
    `/v1/tasks/${tid}/tips/${tip}/feedback`

  it('records a vote and answers 201', async () => {
    const response = await post(votePath(), { helpful: true })

    expect(response.statusCode).toBe(201)
  })

  it('answers 403 when the agent votes on its own tip', async () => {
    guidance.answersVoteTip('cannot-vote-on-own-tip')

    const response = await post(votePath(), { helpful: true })

    expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    expect(response.json().code).toBe('forbidden')
    expect(response.json().message).toContain('own tip')
  })

  it('answers 403 when the agent has not attempted the task', async () => {
    guidance.answersVoteTip('not-entitled')

    const response = await post(votePath(), { helpful: false })

    expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    expect(response.json().code).toBe('forbidden')
    expect(response.json().message).toContain('attempt')
  })

  it('answers 409 on a second vote for the same tip', async () => {
    guidance.answersVoteTip('already-voted')

    const response = await post(votePath(), { helpful: true })

    expect(response.statusCode).toBe(ERROR_STATUS.conflict)
    expect(response.json().code).toBe('conflict')
  })

  it('answers 404 when the tip does not exist', async () => {
    guidance.answersVoteTip('no-such-tip')

    const response = await post(votePath(), { helpful: true })

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
    expect(response.json().code).toBe('not_found')
  })

  /**
   * A non-UUID tipId must be caught at the boundary. Before this fix, the
   * raw string reached Postgres and caused a 500 ("invalid input syntax for
   * type uuid"), which an agent would interpret as a Colony failure and retry
   * forever.
   */
  it('answers 404 for a tipId that is not a UUID, without reaching storage', async () => {
    const response = await post(`/v1/tasks/${taskId}/tips/not-a-uuid/feedback`, { helpful: true })

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
  })

  it('answers 404 for a taskId that is not a UUID, without reaching storage', async () => {
    const response = await post(`/v1/tasks/not-a-uuid/tips/${tipId()}/feedback`, { helpful: true })

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
  })

  it('answers validation_failed when the body is missing the helpful field', async () => {
    const response = await post(votePath(), {})

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
  })

  it('refuses an anonymous caller', async () => {
    const response = await post(votePath(), { helpful: true }, null)

    expect(response.statusCode).toBe(401)
  })
})

/**
 * `#74`: the author's own view, which is the only read path that serves
 * unapproved text.
 *
 * The route's job is the subject rule — own rows, from the credential — and the
 * shape. Which rows those are, and that `moderationNote` reaches the author, is
 * asserted in `packages/db` against a real Postgres.
 */
describe('GET /v1/agents/me/struggles', () => {
  it('answers the documented shape, carrying status and the moderator’s reason', async () => {
    guidance.answersOwnStruggles([
      anOwnStruggle({ taskId, status: 'rejected', moderationNote: 'Name the provider.' }),
    ])

    const response = await get('/v1/agents/me/struggles')

    expect(response.statusCode).toBe(200)
    expect(() => ListOwnStrugglesResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().struggles[0].moderationNote).toBe('Name the provider.')
  })

  it('answers an empty list for an agent that has reported nothing', async () => {
    const response = await get('/v1/agents/me/struggles')

    expect(response.statusCode).toBe(200)
    expect(response.json().struggles).toEqual([])
  })

  it('refuses an anonymous caller', async () => {
    expect((await get('/v1/agents/me/struggles', null)).statusCode).toBe(401)
  })
})

describe('GET /v1/agents/me/tips', () => {
  it('answers the documented shape, carrying status and the moderator’s reason', async () => {
    guidance.answersOwnTips([
      anOwnTip({ taskId, status: 'rejected', moderationNote: 'Say which tool.' }),
    ])

    const response = await get('/v1/agents/me/tips')

    expect(response.statusCode).toBe(200)
    expect(() => ListOwnTipsResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().tips[0].status).toBe('rejected')
  })

  it('refuses an anonymous caller', async () => {
    expect((await get('/v1/agents/me/tips', null)).statusCode).toBe(401)
  })
})
