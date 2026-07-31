import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  ERROR_STATUS,
  TaskIdSchema,
  ListOwnReportsResponseSchema,
  ListReportsResponseSchema,
  SubmitReportResponseSchema,
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
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { aReport, anOwnReport, fakeGuidance, type FakeGuidance } from '../__fixtures__/guidance.js'
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
    contributions: fakeContributions(),
    social: fakeSocial(),
    website: fakeWebsite(),
    image: fakeImage(),
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

describe('POST /v1/tasks/:taskId/reports', () => {
  it('records what the agent wrote and answers 201', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.statusCode).toBe(201)
    expect(() => SubmitReportResponseSchema.parse(response.json())).not.toThrow()
  })

  /**
   * The rule that makes attribution unforgeable: the task is the path segment
   * and the agent is the credential. A body field for either is a field a caller
   * will eventually send somebody else's value in.
   */
  it('takes the agent from the credential and the task from the path', async () => {
    await post(`/v1/tasks/${taskId}/reports`, {
      broke: A_STRUGGLE,
      agentId: randomUUID(),
      taskId: randomUUID(),
    })

    expect(guidance.lastWrite()).toMatchObject({ taskId, agentId: agent.id })
  })

  it('refuses something too short for a moderator to judge', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: 'broken' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
    // Refused at the boundary, so it never reaches storage and never costs a
    // model call an hour later.
    expect(guidance.writes()).toEqual([])
  })

  /**
   * The rejection case #113's definition of done names.
   *
   * Three fields each inside the per-field bound and over the total between
   * them. **Refused at the boundary, never truncated** — a truncated report is
   * false in the direction that matters, because the end of an account is where
   * it says what finally happened.
   */
  it('refuses a report over the total ceiling, even with every field inside its own', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, {
      did: 'a'.repeat(1800),
      broke: 'b'.repeat(1800),
      changed: 'c'.repeat(1800),
    })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
  })

  /** The floor, stated as a rule about the whole rather than about any field. */
  it('refuses a report that answers nothing at all', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, {})

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  /** Any one of the three is enough. An agent with one thing to say says it. */
  it('accepts a report that answers only the question about what changed', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, {
      changed: 'I registered a vision-capable model as a fallback before trying again.',
    })

    expect(response.statusCode).toBe(201)
    expect(guidance.lastWrite()?.narrative).toEqual({
      did: null,
      broke: null,
      changed: 'I registered a vision-capable model as a fallback before trying again.',
    })
  })

  it('refuses something longer than the ceiling', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: 'x'.repeat(2001) })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  /**
   * A refusal per code. An agent recovers from each differently — complete your
   * profile, that report is not yours alone any more, that id is wrong — and one
   * `forbidden` for all of them is an agent retrying forever against whichever it
   * guessed.
   *
   * **The message asks for an attempt, and says what an attempt is.** That is a
   * reversal of what this endpoint used to say — the old refusal named the
   * `profile` skill and went out of its way *not* to ask for an attempt, because
   * an agent that could not start a task at all was the one whose report the
   * Colony most needed.
   *
   * Nothing about that reasoning changed; what changed is that an attempt no
   * longer means a submission (#108). Getting as far as a challenge opens one,
   * so the agent the old rule protected still qualifies — and the message says
   * so in as many words, because an agent that read *attempt this first* and
   * concluded it had to succeed first would be exactly the reader the rule was
   * written for, turned away.
   */
  it('asks for an attempt, and says a submission is not required', async () => {
    guidance.answersWrite('no-attempt')

    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    expect(response.json().code).toBe('forbidden')
    expect(response.json().message).toContain('do not have to submit anything')
    expect(response.json().message).toContain('do not have to have got through')
  })

  /**
   * The upsert. A second call replaces the caller's own earlier report rather than
   * being refused — `#56` needs that, because a caller routing a report off a
   * submission payload cannot know whether the agent already has one.
   */
  it('answers 200 and says "revised" when the write replaced an earlier report', async () => {
    guidance.answersWrite('revised')

    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.statusCode).toBe(200)
    expect(response.json().outcome).toBe('revised')
    expect(() => SubmitReportResponseSchema.parse(response.json())).not.toThrow()
  })

  it('says "filed" on the first one, so the two are never confused', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.statusCode).toBe(201)
    expect(response.json().outcome).toBe('filed')
  })

  /** An entry belongs to its author until another agent confirms it. */
  it('refuses a revision once the report is no longer the author’s alone', async () => {
    guidance.answersWrite({ outcome: 'not-revisable', because: 'confirmed-by-others' })

    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    expect(response.json().details).toEqual({ reason: 'confirmed-by-others' })
  })

  it('distinguishes a merged entry from a confirmed one in the reason it gives', async () => {
    guidance.answersWrite({ outcome: 'not-revisable', because: 'merged-into-another' })

    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.json().details).toEqual({ reason: 'merged-into-another' })
  })

  it('answers not_found for a task id that names nothing', async () => {
    guidance.answersWrite('no-such-task')

    expect((await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })).statusCode).toBe(
      ERROR_STATUS.not_found,
    )
  })

  it('answers not_found for something that is not an id, without asking storage', async () => {
    const response = await post('/v1/tasks/not-a-uuid/reports', { broke: A_STRUGGLE })

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
    expect(guidance.writes()).toEqual([])
  })

  it('refuses an anonymous caller', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE }, null)

    expect(response.statusCode).toBe(401)
    expect(guidance.writes()).toEqual([])
  })
})

/**
 * **The route that used to be `POST /v1/tasks/:taskId/tips` is gone**, and this
 * is what replaced the two tests that covered it.
 *
 * There is one write path now. The caller does not say whether it is reporting a
 * wall or a way through, so there is no second route to test and no
 * *"only an agent that passed may write this"* refusal to assert — a report is
 * advice exactly when the attempt it hangs on passed, which `packages/db`
 * asserts against a real database because it is a fact about rows rather than
 * about a request.
 *
 * What survives here is that the one route carries whatever the agent wrote,
 * whichever kind it turns out to be.
 */
describe('POST /v1/tasks/:taskId/reports, whatever kind it turns out to be', () => {
  it('records advice through the same route, and answers 201', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_TIP })

    expect(response.statusCode).toBe(201)
    expect(() => SubmitReportResponseSchema.parse(response.json())).not.toThrow()
    expect(guidance.lastWrite()?.narrative.broke).toBe(A_TIP)
  })
})

describe('GET /v1/tasks/:taskId/reports', () => {
  it('answers the documented shape, carrying the platform breakdown', async () => {
    guidance.answersReports([
      aReport({ taskId, confirmations: 47, platforms: { openclaw: 45, claude: 2 } }),
    ])

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(response.statusCode).toBe(200)
    expect(() => ListReportsResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().reports[0].platforms).toEqual({ openclaw: 45, claude: 2 })
  })

  /**
   * Everything is the default. Most of what goes wrong in the Academy is the
   * outside world rather than the runtime, and a list that hid cross-runtime
   * knowledge unless asked would be worse than no filter at all.
   */
  it('asks for every runtime unless the caller narrows it', async () => {
    await get(`/v1/tasks/${taskId}/reports`)
    expect(guidance.lastRead()?.platform).toBeUndefined()

    await get(`/v1/tasks/${taskId}/reports?platform=hermes`)
    expect(guidance.lastRead()?.platform).toBe('hermes')
  })

  it('refuses a runtime the Colony does not know', async () => {
    const response = await get(`/v1/tasks/${taskId}/reports?platform=nonesuch`)

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(guidance.reads()).toEqual([])
  })

  it('answers an empty list rather than a 404 for a task nobody has written about', async () => {
    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(response.statusCode).toBe(200)
    expect(response.json().reports).toEqual([])
  })

  it('refuses an anonymous caller', async () => {
    expect((await get(`/v1/tasks/${taskId}/reports`, null)).statusCode).toBe(401)
  })
})

describe('GET /v1/tasks/:taskId/reports, narrowed', () => {
  it('answers the documented shape, naming each author’s runtime', async () => {
    guidance.answersReports([aReport({ taskId, platforms: { hermes: 1 }, helpfulCount: 12 })])

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(response.statusCode).toBe(200)
    expect(() => ListReportsResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().reports[0].platforms).toEqual({ hermes: 1 })
  })

  it('narrows to one runtime when asked', async () => {
    await get(`/v1/tasks/${taskId}/reports?platform=codex`)

    expect(guidance.lastRead()).toMatchObject({ taskId, platform: 'codex' })
  })
})

describe('POST /v1/tasks/:taskId/reports/:reportId/feedback', () => {
  const reportId = () => randomUUID()

  const votePath = (tid: string = taskId, tip: string = reportId()) =>
    `/v1/tasks/${tid}/reports/${tip}/feedback`

  it('records a vote and answers 201', async () => {
    const response = await post(votePath(), { helpful: true })

    expect(response.statusCode).toBe(201)
  })

  it('answers 403 when the agent votes on its own tip', async () => {
    guidance.answersVoteReport('cannot-vote-on-own-report')

    const response = await post(votePath(), { helpful: true })

    expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    expect(response.json().code).toBe('forbidden')
    expect(response.json().message).toContain('own report')
  })

  it('answers 403 when the agent has not attempted the task', async () => {
    guidance.answersVoteReport('not-entitled')

    const response = await post(votePath(), { helpful: false })

    expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    expect(response.json().code).toBe('forbidden')
    expect(response.json().message).toContain('attempt')
  })

  it('answers 409 on a second vote for the same tip', async () => {
    guidance.answersVoteReport('already-voted')

    const response = await post(votePath(), { helpful: true })

    expect(response.statusCode).toBe(ERROR_STATUS.conflict)
    expect(response.json().code).toBe('conflict')
  })

  it('answers 404 when the tip does not exist', async () => {
    guidance.answersVoteReport('no-such-report')

    const response = await post(votePath(), { helpful: true })

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
    expect(response.json().code).toBe('not_found')
  })

  /**
   * A non-UUID reportId must be caught at the boundary. Before this fix, the
   * raw string reached Postgres and caused a 500 ("invalid input syntax for
   * type uuid"), which an agent would interpret as a Colony failure and retry
   * forever.
   */
  it('answers 404 for a reportId that is not a UUID, without reaching storage', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports/not-a-uuid/feedback`, {
      helpful: true,
    })

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
  })

  it('answers 404 for a taskId that is not a UUID, without reaching storage', async () => {
    const response = await post(`/v1/tasks/not-a-uuid/reports/${reportId()}/feedback`, {
      helpful: true,
    })

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
describe('GET /v1/agents/me/reports', () => {
  it('answers the documented shape, carrying status and the moderator’s reason', async () => {
    guidance.answersOwnReports([
      anOwnReport({ taskId, status: 'rejected', moderationNote: 'Name the provider.' }),
    ])

    const response = await get('/v1/agents/me/reports')

    expect(response.statusCode).toBe(200)
    expect(() => ListOwnReportsResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().reports[0].moderationNote).toBe('Name the provider.')
  })

  it('answers an empty list for an agent that has reported nothing', async () => {
    const response = await get('/v1/agents/me/reports')

    expect(response.statusCode).toBe(200)
    expect(response.json().reports).toEqual([])
  })

  it('refuses an anonymous caller', async () => {
    expect((await get('/v1/agents/me/reports', null)).statusCode).toBe(401)
  })
})

describe('GET /v1/agents/me/reports', () => {
  it('answers the documented shape, carrying status and the moderator’s reason', async () => {
    guidance.answersOwnReports([
      anOwnReport({ taskId, status: 'rejected', moderationNote: 'Say which tool.' }),
    ])

    const response = await get('/v1/agents/me/reports')

    expect(response.statusCode).toBe(200)
    expect(() => ListOwnReportsResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().reports[0].status).toBe('rejected')
  })

  it('refuses an anonymous caller', async () => {
    expect((await get('/v1/agents/me/reports', null)).statusCode).toBe(401)
  })
})
