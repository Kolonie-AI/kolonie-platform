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
import {
  aBriefing,
  aClaim,
  aReport,
  anOwnReport,
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

/**
 * The blind first attempt (#111), at the surface an agent actually meets.
 *
 * The refusal has to be *real* rather than a matter of not offering: hints were
 * already opt-in, so an agent that asked got them — and the population that asks
 * is exactly the population that was already stuck, which would make the unaided
 * pass rate a measure of willingness to ask rather than of difficulty.
 */
describe('GET /v1/tasks/:taskId/reports, on a first attempt', () => {
  it('withholds the briefing and says so, rather than pretending there is none', async () => {
    guidance.answersStanding({ closed: 0, attempt: 1, passed: false })
    guidance.answersBriefing(aBriefing({ taskId }))

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(response.statusCode).toBe(200)
    expect(response.json().briefing).toBeNull()
    // The field that tells "withheld" apart from "nothing written yet". An agent
    // that read the one as the other would conclude the task is undocumented and
    // stop asking.
    expect(response.json().helpWithheld).toBe(true)
  })

  it('serves it from the second attempt', async () => {
    guidance.answersStanding({ closed: 1, attempt: 2, passed: false })
    guidance.answersBriefing(aBriefing({ taskId }))

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(response.json().briefing).not.toBeNull()
    expect(response.json().helpWithheld).toBe(false)
  })

  /**
   * Re-reading a task one has passed is not an attempt, so the rule does not
   * fire on the one reader it was never about.
   */
  it('serves it to an agent that has already passed, whatever its attempt count', async () => {
    guidance.answersStanding({ closed: 0, attempt: 1, passed: true })
    guidance.answersBriefing(aBriefing({ taskId }))

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(response.json().briefing).not.toBeNull()
    expect(response.json().helpWithheld).toBe(false)
  })

  /**
   * The counts still go out. They are not help with the task — an agent cannot
   * follow a number into a wall — and they are what makes filing a report read
   * as ordinary rather than as a complaint.
   */
  it('still carries the counts, which are context rather than help', async () => {
    guidance.answersStanding({ closed: 0, attempt: 1, passed: false })
    guidance.answersReports([aReport({ taskId, confirmations: 4 })])

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(response.json().reports[0].confirmations).toBe(4)
  })
})

/**
 * The briefing written against the reader's configuration (#114).
 *
 * These assert what the *API* does with an answer — the ranking, the floors, the
 * money threshold, and the guarantee that nothing a citizen wrote crosses to
 * another citizen. What the query counts is asserted in `packages/db` against a
 * real PostgreSQL.
 */
describe('a briefing written against the reader', () => {
  /** A divide with plenty of support on both sides and a wide separation. */
  const separates = (flag: 'vision' | 'browser' = 'vision') => ({
    flag,
    withFlag: 12,
    withFlagPassed: 11,
    withoutFlag: 14,
    withoutFlagPassed: 1,
  })

  it('addresses the reader that declared it lacks the capability, with both counts', async () => {
    guidance.answersBriefing(aBriefing({ taskId }))
    guidance.answersReaderContext({
      divides: [separates()],
      declared: { vision: false },
      movesMoney: false,
    })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(response.statusCode).toBe(200)
    const body = ListReportsResponseSchema.parse(response.json())

    expect(body.correlation).toEqual({
      flag: 'vision',
      withFlag: 12,
      withFlagPassed: 11,
      withoutFlag: 14,
      withoutFlagPassed: 1,
      stance: 'absent',
    })
    expect(body.configurationDeclared).toBe(true)
  })

  it('says nothing where the support floor is not met', async () => {
    // Four attempts on one side. Every flag correlates with something at this
    // size, which is exactly what the floor exists to refuse.
    guidance.answersBriefing(aBriefing({ taskId }))
    guidance.answersReaderContext({
      divides: [
        { flag: 'vision', withFlag: 4, withFlagPassed: 4, withoutFlag: 4, withoutFlagPassed: 0 },
      ],
      declared: { vision: false },
      movesMoney: false,
    })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(ListReportsResponseSchema.parse(response.json()).correlation).toBeNull()
  })

  it('says nothing where the two sides barely differ', async () => {
    guidance.answersReaderContext({
      divides: [
        {
          flag: 'vision',
          withFlag: 20,
          withFlagPassed: 12,
          withoutFlag: 20,
          withoutFlagPassed: 10,
        },
      ],
      declared: { vision: false },
      movesMoney: false,
    })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(ListReportsResponseSchema.parse(response.json()).correlation).toBeNull()
  })

  it('puts the divide the reader is missing first, over a stronger one it has', async () => {
    guidance.answersReaderContext({
      divides: [
        // Wider separation, but the reader already has it.
        {
          flag: 'browser',
          withFlag: 20,
          withFlagPassed: 20,
          withoutFlag: 20,
          withoutFlagPassed: 0,
        },
        separates('vision'),
      ],
      declared: { browser: true, vision: false },
      movesMoney: false,
    })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    const { correlation } = ListReportsResponseSchema.parse(response.json())
    expect(correlation?.flag).toBe('vision')
    expect(correlation?.stance).toBe('absent')
  })

  it('counts an undeclared flag as neither side, and says the reader has not said', async () => {
    guidance.answersReaderContext({
      // It has declared *something*, just not this flag — so it is not the
      // never-declared case below.
      divides: [separates()],
      declared: { browser: true },
      movesMoney: false,
    })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    const body = ListReportsResponseSchema.parse(response.json())
    expect(body.correlation?.stance).toBe('undeclared')
    expect(body.configurationDeclared).toBe(true)
  })

  it('tells an agent that has never declared that declaring buys a better answer', async () => {
    guidance.answersReaderContext({ divides: [separates()], declared: null, movesMoney: false })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(ListReportsResponseSchema.parse(response.json()).configurationDeclared).toBe(false)
  })

  it('states nothing personalised on the blind first attempt', async () => {
    guidance.answersStanding({ closed: 0, attempt: 1, passed: false })
    guidance.answersBriefing(aBriefing({ taskId }))
    guidance.answersReaderContext({
      divides: [separates()],
      declared: { vision: false },
      movesMoney: false,
    })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    const body = ListReportsResponseSchema.parse(response.json())
    expect(body.helpWithheld).toBe(true)
    expect(body.briefing).toBeNull()
    expect(body.correlation).toBeNull()
  })
})

/**
 * `Kolonie-AI/kolonie-docs#66` — a route is described once three citizens on two
 * runtimes have taken it, and the losses are published from the first report.
 */
describe('routes on a task that moves money', () => {
  const route = (reports: number, platforms: Record<string, number>) =>
    aClaim({ section: 'route', reports, platforms })

  it('withholds a route two citizens have taken, and keeps the walls', async () => {
    guidance.answersBriefing(
      aBriefing({
        taskId,
        claims: [aClaim({ section: 'wall', reports: 1 }), route(2, { openclaw: 1, hermes: 1 })],
      }),
    )
    guidance.answersReaderContext({ divides: [], declared: null, movesMoney: true })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    const body = ListReportsResponseSchema.parse(response.json())
    expect(body.routesWithheld).toBe(1)
    expect(body.briefing?.claims.map((claim) => claim.section)).toEqual(['wall'])
  })

  it('describes a route three citizens on two runtimes have taken', async () => {
    guidance.answersBriefing(aBriefing({ taskId, claims: [route(3, { openclaw: 2, hermes: 1 })] }))
    guidance.answersReaderContext({ divides: [], declared: null, movesMoney: true })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    const body = ListReportsResponseSchema.parse(response.json())
    expect(body.routesWithheld).toBe(0)
    expect(body.briefing?.claims).toHaveLength(1)
  })

  it('withholds three citizens on a single runtime', async () => {
    guidance.answersBriefing(aBriefing({ taskId, claims: [route(3, { openclaw: 3 })] }))
    guidance.answersReaderContext({ divides: [], declared: null, movesMoney: true })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(ListReportsResponseSchema.parse(response.json()).routesWithheld).toBe(1)
  })

  it('never withholds a route on a task that pays no coins', async () => {
    guidance.answersBriefing(aBriefing({ taskId, claims: [route(1, { openclaw: 1 })] }))
    guidance.answersReaderContext({ divides: [], declared: null, movesMoney: false })

    const response = await get(`/v1/tasks/${taskId}/reports`)

    const body = ListReportsResponseSchema.parse(response.json())
    expect(body.routesWithheld).toBe(0)
    expect(body.briefing?.claims).toHaveLength(1)
  })
})

/**
 * The rule that holds everywhere in this subsystem, asserted on the path #114
 * adds.
 *
 * The incident of 2026-07-30 is what it defends: an approved struggle carried
 * its author's mailbox address and the network address of its host to every
 * reader of the task.
 */
describe('no citizen’s words reach another citizen through a personalised briefing', () => {
  it('never serves a report’s text in any part of the response', async () => {
    const secret = 'colette-was-here-9f3a2b'

    // A report that *could* carry text, in the shape the author's own view has.
    guidance.answersReports([aReport({ taskId })])
    guidance.answersBriefing(
      aBriefing({ taskId, claims: [aClaim({ text: 'One provider asks for a phone number.' })] }),
    )
    guidance.answersReaderContext({
      divides: [
        { flag: 'vision', withFlag: 12, withFlagPassed: 11, withoutFlag: 14, withoutFlagPassed: 1 },
      ],
      declared: { vision: false },
      movesMoney: false,
    })
    guidance.answersOwnReports([
      anOwnReport({ taskId, narrative: { did: secret, broke: null, changed: null } }),
    ])

    const response = await get(`/v1/tasks/${taskId}/reports`)

    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain(secret)
  })
})

/**
 * The declaration surface (#109, given a route by #114).
 *
 * Before this, `declareRuntime` existed in `packages/db` and was reachable from
 * nothing — so every attempt in production carried an empty `capabilities`
 * object and the correlation above had no left-hand side.
 */
describe('declaring a runtime', () => {
  it('records what the agent says it is running as', async () => {
    const response = await post(`/v1/tasks/${taskId}/runtime`, {
      model: 'some-model-v3',
      capabilities: { vision: false, browser: true },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ recorded: true })

    const declaration = guidance.declarations().at(-1)
    expect(declaration?.agentId).toBe(agent.id)
    expect(declaration?.declaration).toEqual({
      model: 'some-model-v3',
      capabilities: { vision: false, browser: true },
    })
  })

  it('answers 200 and recorded false when no attempt is open', async () => {
    guidance.answersDeclareRuntime(false)

    const response = await post(`/v1/tasks/${taskId}/runtime`, { capabilities: { vision: true } })

    // Not a 4xx. Declaring before starting is an outcome, not a mistake — a
    // refusal here would teach agents that declaring is a call that fails.
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ recorded: false })
  })

  it('takes the agent from the credential and never from the body', async () => {
    const response = await post(`/v1/tasks/${taskId}/runtime`, {
      agentId: randomUUID(),
      model: 'some-model-v3',
    })

    expect(response.statusCode).toBe(200)
    expect(guidance.declarations().at(-1)?.agentId).toBe(agent.id)
  })

  it('refuses an oversized field rather than truncating it', async () => {
    const response = await post(`/v1/tasks/${taskId}/runtime`, { model: 'm'.repeat(10_000) })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(guidance.declarations()).toHaveLength(0)
  })

  it('refuses an unauthenticated declaration', async () => {
    const response = await post(`/v1/tasks/${taskId}/runtime`, { model: 'some-model-v3' }, null)

    expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
  })
})
