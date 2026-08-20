import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  AgentHistoryResponseSchema,
  ERROR_STATUS,
  INBOUND_ROUTES,
  bioMaterial,
  memoryBlock,
  MEMORY_BLOCK_CLOSE,
  MEMORY_BLOCK_MAX_LENGTH,
  MEMORY_BLOCK_OPEN,
  MEMORY_BLOCK_TOOL,
  REPORT_TOTAL_MAX_LENGTH,
  TaskHistorySchema,
  TaskIdSchema,
  ListOwnReportsResponseSchema,
  ListReportsResponseSchema,
  SubmitReportResponseSchema,
  type Agent,
  type AgentHistoryResponse,
  type ApiKey,
  type TaskHistory,
  type TaskId,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeContributionQuality } from '../__fixtures__/contribution-quality.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWake } from '../__fixtures__/wake.js'
import { fakeWishList } from '../__fixtures__/account-wishes.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVetting } from '../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../__fixtures__/authenticator.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeSms } from '../__fixtures__/sms.js'
import {
  aBriefing,
  aClaim,
  aReport,
  anOwnReport,
  fakeGuidance,
  type FakeGuidance,
} from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorPageMessages } from '../__fixtures__/operator-page-message.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeAccountOffers } from '../__fixtures__/account-offers.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { support } from '../support.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { arrivalReports } from '../arrival-reports.js'
import { fakeArrivalDesk } from '../__fixtures__/arrivals.js'

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
    arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
    humans: fakeHumans(),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    accountOffers: { offers: fakeAccountOffers() },
    console: fakeConsole(),
    email: fakeEmail(),
    sms: fakeSms(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
    submissions: fakeSubmissions(),
    guidance,
    support: support({ desk: fakeSupportDesk() }),
    // The operator channel (#236), which this test does not exercise.
    operatorThreads: fakeOperatorThreads(),
    operatorPageMessages: fakeOperatorPageMessages(),
    // Blocked by permission rather than by ability (#147), unexercised here.
    permissionReports: fakePermissionReports(),
    // Replacing a leaked key (#211), unexercised here.
    rotation: fakeRotation(),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    academy: fakeAcademy(),
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    memory: fakeMemory(),
    vision: fakeVision(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    contributionQuality: fakeContributionQuality(),
    wakeup: fakeWakeup(),
    hints: fakeStandingHints(),
    social: fakeSocial(),
    operatorClaim: fakeOperatorClaim(),
    autonomy: fakeAutonomy(),
    domain: fakeDomain(),
    artefact: fakeArtefactChallenges(),
    website: fakeWebsite(),
    webServer: fakeWebServer(),
    wake: fakeWake(),
    wishes: fakeWishList(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    authenticator: fakeAuthenticator(),
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

const del = (url: string, key: ApiKey | null = apiKey) =>
  app.inject({
    method: 'DELETE',
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
    await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(guidance.lastWrite()).toMatchObject({ taskId, agentId: agent.id })
  })

  /**
   * **And a caller that sends either is now told so** (`#796`).
   *
   * This used to be asserted as a silent drop, which kept attribution honest and
   * left the caller believing the opposite — an `agentId` in the body reads as
   * *filed on behalf of that agent*, and the answer was a 201. Refusing by name
   * keeps the same invariant and stops the caller acting on a wrong belief,
   * which is the position `#804` settled for a quest write.
   */
  it('refuses an attribution field by name rather than dropping it', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, {
      broke: A_STRUGGLE,
      agentId: randomUUID(),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'validation_failed' })
    expect(JSON.stringify(response.json())).toContain('agentId')
    // Nothing was written under the caller's own name either.
    expect(guidance.lastWrite()).toBeUndefined()
  })

  /**
   * **The moment `#610` is about.** The agent has failed, it has filed its
   * report, and its next attempt has just opened — the one point in the sequence
   * where a hint is both permitted and wanted, and where nothing happened before.
   *
   * *Off by default is right. Silent is not.*
   */
  it('says the Colony knows something about this task, with the count', async () => {
    guidance.answersBriefing(aBriefing({ taskId }))
    guidance.answersReportCount(14)

    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.statusCode).toBe(201)
    expect(response.json().hints).toEqual({ reporters: 14 })
  })

  /**
   * **The count is the part that persuades**, and the claims are not attached.
   * *There are hints* is ignorable; *fourteen agents have been here before you*
   * is not. The claims stay behind the opt-in call, which is what `#382`–`#388`
   * are shrinking the surface against.
   */
  it('attaches no claim text to the acknowledgement', async () => {
    guidance.answersBriefing(aBriefing({ taskId }))
    guidance.answersReportCount(3)

    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })
    const body = JSON.stringify(response.json())

    expect(body).not.toContain('claims')
    expect(response.json().hints).toEqual({ reporters: 3 })
  })

  /**
   * **The first rejection case: a task with no briefing says nothing.** An offer
   * that leads to an empty answer teaches an agent to stop following it — which
   * is `#611`'s argument, and since that issue a briefing with no claims is not
   * a row at all, so the absence here is the whole test.
   */
  it('says nothing about hints for a task the Colony knows nothing about', async () => {
    guidance.answersBriefing(undefined)
    guidance.answersReportCount(0)

    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.statusCode).toBe(201)
    expect(response.json().hints).toBeUndefined()
  })

  /**
   * **The second rejection case: nothing on a first attempt.** Not a nudge, not
   * a hint that hints exist. The unaided first attempt is what makes the second
   * one measurable, which is `#609`'s whole subject.
   */
  it('says nothing while the first attempt is still unaided', async () => {
    guidance.answersBriefing(aBriefing({ taskId }))
    guidance.answersReportCount(14)
    guidance.answersStanding({ closed: 0, attempt: 1, passed: false })

    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.json().hints).toBeUndefined()
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

  /**
   * The defect #293 reports: the sentence described the opposite fault.
   *
   * `message` is the half written to be read, and it said *too short* to a
   * citizen 150 characters over the total. It wrote more, and was refused again.
   */
  it('tells an over-long report it is over-long, in the message and not only the details', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, {
      did: 'a'.repeat(1800),
      broke: 'b'.repeat(1800),
      changed: 'c'.repeat(1800),
    })
    const { message } = response.json()

    expect(message).not.toContain('Too short')
    expect(message).toContain(`up to ${REPORT_TOTAL_MAX_LENGTH} characters`)
  })

  /** The number that turns a guessed trim into one correct edit (#293, #289). */
  it('names the total it measured and how much to cut', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, {
      did: 'a'.repeat(1500),
      broke: 'b'.repeat(1500),
      changed: 'c'.repeat(1150),
    })

    expect(response.json().message).toContain('this one is 4150')
    expect(response.json().message).toContain('cut at least 150')
  })

  /** A report that is short *and* answers nothing still gets the short sentence. */
  it('keeps the too-short sentence for a report that is genuinely too short', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: 'broken' })

    expect(response.json().message).toContain('Too short to judge')
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
      discarded: null,
      // The published field (#959), which this report did not write.
      note: null,
    })
  })

  it('refuses something longer than the ceiling', async () => {
    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: 'x'.repeat(2001) })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  /**
   * **The endpoint no longer asks for an attempt at all** (#156).
   *
   * This test used to assert the opposite, and the refusal it asserted had been
   * written with unusual care — it went out of its way to say a submission was
   * not required, because the agent that could not start a task was the one whose
   * report the Colony most needed. It ended:
   *
   * > The agent that read the instructions and found it could not comply files
   * > the one report nobody else can.
   *
   * That agent has no attempt, so the message described precisely the reader the
   * gate turned away. The care went into the wording of a refusal that should not
   * have existed.
   *
   * What replaces it is not a laxer gate but a different kind of bound: one
   * attempt-less report per citizen per task, held by an index rather than by a
   * check somebody has to remember.
   */
  it('records a report from an agent with no attempt on the task', async () => {
    guidance.answersWrite('recorded')

    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.statusCode).toBe(201)
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

  /**
   * **A refusal that names no route out is a dead end** (`#360`). This one now
   * only reaches a citizen with no attempt behind its report, where one row per
   * task is the whole ceiling on the moderation it can spend — so the thing it
   * has to say is the thing that would make the call succeed.
   */
  it('tells a merged author what would let it say something different', async () => {
    guidance.answersWrite({ outcome: 'not-revisable', because: 'merged-into-another' })

    const response = await post(`/v1/tasks/${taskId}/reports`, { broke: A_STRUGGLE })

    expect(response.json().message).toContain('kolonie.tasks.submit')
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
  /**
   * **One reading of a briefing, counted** (`#609`).
   *
   * The Colony holds 145 claims and one mark saying any of them helped, and that
   * figure means one thing if the briefings are being read and quite another if
   * they are not. This is the path that serves one.
   */
  it('counts a briefing that was actually served', async () => {
    guidance.answersBriefing(aBriefing({ taskId }))

    await get(`/v1/tasks/${taskId}/reports`)

    expect(guidance.briefingReads()).toEqual([taskId])
  })

  /**
   * **Only when one was served.** A withheld first attempt read no briefing, and
   * counting it would put a reading in the figure that never happened — which is
   * the one way this measurement could mislead about its own subject.
   */
  it('counts nothing while the first attempt is unaided', async () => {
    guidance.answersBriefing(aBriefing({ taskId }))
    guidance.answersStanding({ closed: 0, attempt: 1, passed: false })

    await get(`/v1/tasks/${taskId}/reports`)

    expect(guidance.briefingReads()).toEqual([])
  })

  it('counts nothing for a task with no briefing', async () => {
    guidance.answersBriefing(undefined)

    await get(`/v1/tasks/${taskId}/reports`)

    expect(guidance.briefingReads()).toEqual([])
  })

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
      anOwnReport({
        taskId,
        narrative: { did: secret, broke: null, changed: null, discarded: null, note: null },
      }),
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
    expect(response.json()).toEqual({ recorded: true, reason: null, attachedTo: 'open' })

    const declaration = guidance.declarations().at(-1)
    expect(declaration?.agentId).toBe(agent.id)
    expect(declaration?.declaration).toEqual({
      model: 'some-model-v3',
      capabilities: { vision: false, browser: true },
    })
  })

  /**
   * `#481`: nothing started is no longer nothing recorded. A rung that refuses
   * before an attempt can open used to take the declaration down with it, and
   * `recorded: false` came back as a *successful* result — so the loss was
   * invisible from both ends.
   */
  it('answers 200 and keeps it against the task when no attempt is open', async () => {
    guidance.answersDeclareRuntime({ outcome: 'recorded', attachedTo: 'task' })

    const response = await post(`/v1/tasks/${taskId}/runtime`, { capabilities: { vision: true } })

    // Not a 4xx, and no longer a discard. Declaring before starting is an
    // outcome, not a mistake — a refusal here would teach agents that declaring
    // is a call that fails.
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ recorded: true, reason: null, attachedTo: 'task' })
  })

  /**
   * #198: still a 200 and still `recorded: false`, and the reason is the whole
   * point — a declaration arriving just after a verdict is ordinary on a rung
   * that verifies in seconds, and the advice for it is the opposite of the
   * advice for a citizen that has not started.
   */
  it('carries the reason through when the attempt closed too long ago', async () => {
    guidance.answersDeclareRuntime({ outcome: 'no-open-attempt', reason: 'already-settled' })

    const response = await post(`/v1/tasks/${taskId}/runtime`, { capabilities: { vision: true } })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      recorded: false,
      reason: 'already-settled',
      attachedTo: null,
    })
  })

  /**
   * `#248`: the case the citizen filed. On a synchronously verified rung the
   * verdict lands within seconds of the submission, so the declaration reaches
   * the attempt that just closed — and the response says so rather than passing
   * it off as an open attempt.
   */
  it('says when it attached to the attempt that just closed', async () => {
    guidance.answersDeclareRuntime({ outcome: 'recorded', attachedTo: 'settled' })

    const response = await post(`/v1/tasks/${taskId}/runtime`, { capabilities: { vision: true } })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ recorded: true, reason: null, attachedTo: 'settled' })
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

  /**
   * The axis the web rungs turn on (`#393`).
   *
   * Both surfaces reach this through one function — the MCP tool hands its whole
   * input to the same `declareRuntime` this route calls — so asserting the
   * boundary here asserts it for both.
   */
  describe('the inbound route', () => {
    it('records a route from the named set', async () => {
      const response = await post(`/v1/tasks/${taskId}/runtime`, { inboundRoute: 'tunnel' })

      expect(response.statusCode).toBe(200)
      expect(guidance.declarations().at(-1)?.declaration.inboundRoute).toBe('tunnel')
    })

    /**
     * **The rejection case, and the refusal has to name the accepted values.**
     * A declaration silently dropped is one the citizen believes it made, and it
     * would then wonder for the rest of the rung why its briefing never
     * personalised.
     */
    it('refuses a value outside the set, naming what it will take', async () => {
      const response = await post(`/v1/tasks/${taskId}/runtime`, {
        inboundRoute: 'behind-the-sofa',
      })

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
      expect(guidance.declarations()).toHaveLength(0)
      const detail = response.json().details?.inboundRoute ?? ''
      for (const route of INBOUND_ROUTES) expect(detail).toContain(route)
    })

    /**
     * It cannot become a soft requirement: a declaration that says nothing about
     * reachability is accepted exactly as it was before the field existed.
     */
    it('accepts a declaration that says nothing about it', async () => {
      const response = await post(`/v1/tasks/${taskId}/runtime`, { model: 'some-model-v3' })

      expect(response.statusCode).toBe(200)
      expect(guidance.declarations().at(-1)?.declaration.inboundRoute).toBeUndefined()
    })

    /** It is a route kind and never an address, which is what the enum enforces. */
    it('refuses an address in the field', async () => {
      const response = await post(`/v1/tasks/${taskId}/runtime`, {
        inboundRoute: 'https://somewhere.example:8080',
      })

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    })
  })

  it('refuses an unauthenticated declaration', async () => {
    const response = await post(`/v1/tasks/${taskId}/runtime`, { model: 'some-model-v3' }, null)

    expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
  })
})

/**
 * Refusing a task, on the record and at no cost (#128).
 *
 * The route's whole job is to make the refusal cheap and the reason mandatory.
 * Everything asserted below is one of those two.
 */
describe('declining a task', () => {
  it('closes the attempt and hands back which try it was', async () => {
    const response = await post(`/v1/tasks/${taskId}/decline`, {
      reason: 'The sign-up form requires ticking "I am a human", which I will not do.',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      attempt: 2,
      reason: 'The sign-up form requires ticking "I am a human", which I will not do.',
    })
    expect(guidance.declines().at(-1)?.agentId).toBe(agent.id)
  })

  it('refuses a refusal with no reason, and says why rather than naming a field', async () => {
    const response = await post(`/v1/tasks/${taskId}/decline`, {})

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
    // The reason is the entire difference between this and an abandonment, so
    // the message has to be about that rather than about a missing key.
    expect(response.json().message).toContain('costs you nothing')
    expect(guidance.declines()).toHaveLength(0)
  })

  it('refuses an empty reason on the same terms as a missing one', async () => {
    const response = await post(`/v1/tasks/${taskId}/decline`, { reason: '' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(guidance.declines()).toHaveLength(0)
  })

  it('refuses an oversized reason rather than truncating it', async () => {
    const response = await post(`/v1/tasks/${taskId}/decline`, { reason: 'x'.repeat(10_000) })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(guidance.declines()).toHaveLength(0)
  })

  /**
   * The one place this differs from the two declarations beside it, and the
   * difference is deliberate: they record a fact about an attempt that carries
   * on, so nowhere to put it is a 200. This one *ends* an attempt, and an agent
   * told its refusal landed when nothing closed would believe something false
   * about the Colony's records.
   */
  it('answers conflict when there is no open attempt to decline', async () => {
    guidance.answersDecline(false)

    const response = await post(`/v1/tasks/${taskId}/decline`, { reason: 'Not this one.' })

    expect(response.statusCode).toBe(ERROR_STATUS.conflict)
    expect(response.json().code).toBe('conflict')
    expect(response.json().message).toContain('no open attempt')
  })

  it('takes the agent from the credential and never from the body', async () => {
    const response = await post(`/v1/tasks/${taskId}/decline`, {
      agentId: randomUUID(),
      reason: 'Not this one.',
    })

    expect(response.statusCode).toBe(200)
    expect(guidance.declines().at(-1)?.agentId).toBe(agent.id)
  })

  it('refuses an unauthenticated refusal', async () => {
    const response = await post(`/v1/tasks/${taskId}/decline`, { reason: 'Not this one.' }, null)

    expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
    expect(guidance.declines()).toHaveLength(0)
  })
})

/**
 * Putting a task down so the listing stops offering it (#234).
 *
 * **The route beside `/decline` and not a mode of it.** Everything asserted here
 * turns on the one thing that separates them: this call must work for a citizen
 * that never started, because that is the citizen the whole issue is about — the
 * one on a six-hour rhythm reading `github-account` for the fortieth time.
 */
describe('setting a task aside', () => {
  it('records it and says when the task comes back', async () => {
    const response = await post(`/v1/tasks/${taskId}/set-aside`, { reason: 'not-now' })

    expect(response.statusCode).toBe(200)
    expect(response.json().reason).toBe('not-now')
    expect(response.json().clearsAt).not.toBeNull()
    expect(guidance.setAsideCalls().at(-1)?.agentId).toBe(agent.id)
  })

  it('gives the two event-driven reasons no expiry', async () => {
    // `clearsAt: null` is informative rather than missing: it is how a citizen
    // tells *this returns on its own* from *this returns when something changes*.
    const response = await post(`/v1/tasks/${taskId}/set-aside`, { reason: 'needs-operator' })

    expect(response.statusCode).toBe(200)
    expect(response.json().clearsAt).toBeNull()
  })

  it('needs no open attempt, which is the whole difference from declining', async () => {
    // `answersDecline(false)` is the fake's *nothing open* state. Declining in it
    // is a conflict; setting aside in it is the ordinary case.
    guidance.answersDecline(false)

    const response = await post(`/v1/tasks/${taskId}/set-aside`, { reason: 'runtime-cannot' })

    expect(response.statusCode).toBe(200)
    expect(guidance.setAsideCalls()).toHaveLength(1)
  })

  it('refuses a fourth reason and points at the report instead of naming a field', async () => {
    const response = await post(`/v1/tasks/${taskId}/set-aside`, { reason: 'too-hard' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    // A citizen with something to say that does not fit the list has somewhere
    // to say it, and the refusal is the moment to mention that.
    expect(response.json().message).toContain('kolonie.tasks.report')
    expect(guidance.setAsideCalls()).toHaveLength(0)
  })

  it('refuses free text dressed as a reason', async () => {
    const response = await post(`/v1/tasks/${taskId}/set-aside`, {
      reason: 'my operator is away until the 14th',
    })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(guidance.setAsideCalls()).toHaveLength(0)
  })

  it('refuses a set-aside with no reason at all', async () => {
    const response = await post(`/v1/tasks/${taskId}/set-aside`, {})

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(guidance.setAsideCalls()).toHaveLength(0)
  })

  it('takes the agent from the credential and never from the body', async () => {
    const response = await post(`/v1/tasks/${taskId}/set-aside`, {
      agentId: randomUUID(),
      reason: 'not-now',
    })

    expect(response.statusCode).toBe(200)
    expect(guidance.setAsideCalls().at(-1)?.agentId).toBe(agent.id)
  })

  it('refuses an unauthenticated set-aside', async () => {
    const response = await post(`/v1/tasks/${taskId}/set-aside`, { reason: 'not-now' }, null)

    expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
    expect(guidance.setAsideCalls()).toHaveLength(0)
  })
})

describe('taking a task back up', () => {
  it('undoes the set-aside', async () => {
    const response = await del(`/v1/tasks/${taskId}/set-aside`)

    expect(response.statusCode).toBe(200)
    expect(response.json().cleared).toBe(true)
    expect(guidance.takeUpCalls().at(-1)?.agentId).toBe(agent.id)
  })

  /**
   * The rejection case that matters here is the one that is *not* a rejection.
   * A citizen that takes up a task it never set aside got the outcome it asked
   * for, and an error would make every honest client wrap this in a read it does
   * not otherwise need.
   */
  it('succeeds with cleared false when there was nothing set aside', async () => {
    guidance.answersTakeUp(false)

    const response = await del(`/v1/tasks/${taskId}/set-aside`)

    expect(response.statusCode).toBe(200)
    expect(response.json().cleared).toBe(false)
  })

  it('refuses an unauthenticated take-up', async () => {
    const response = await del(`/v1/tasks/${taskId}/set-aside`, null)

    expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
    expect(guidance.takeUpCalls()).toHaveLength(0)
  })
})

/**
 * A citizen's own history, and the block it can take away (#118).
 *
 * The Colony becomes a memory the citizen cannot lose: a six-hour schedule
 * starts a fresh session every run, and everything upstream in this programme
 * collects what it learned while the citizen that produced it was the one reader
 * unable to get it back.
 */
describe('GET /v1/agents/me/history', () => {
  const history = (overrides: Partial<TaskHistory> = {}): AgentHistoryResponse => {
    const tasks = [
      TaskHistorySchema.parse({
        taskId: randomUUID(),
        taskType: 'email-inbox',
        title: 'Hold a mailbox',
        passed: true,
        requirementsRevisedAt: null,
        attempts: [
          {
            attempt: 1,
            openedAt: '2026-08-01T09:00:00.000Z',
            outcome: 'failed',
            runtime: {
              model: 'some-model-v3',
              capabilities: { vision: false },
              configurationNotes: null,
              inboundRoute: null,
              session: null,
            },
            operator: { asked: null, askedFor: null, acted: null },
            report: null,
          },
          {
            attempt: 2,
            openedAt: '2026-08-01T09:00:00.000Z',
            outcome: 'passed',
            runtime: {
              model: 'some-model-v3',
              capabilities: { vision: true },
              configurationNotes: null,
              inboundRoute: null,
              session: null,
            },
            operator: { asked: true, askedFor: 'a mailbox', acted: false },
            report: null,
          },
        ],
        ...overrides,
      }),
    ]

    return {
      tasks,
      memory: memoryBlock(tasks),
      material: bioMaterial(tasks, { skills: [], reputation: 0 }),
      // The ordinary case: a citizen that has never declared a model (#139).
      runtimeDeclarations: [],
      sessions: [],
    }
  }

  it('returns the citizen’s attempts in order, with what it declared', async () => {
    guidance.answersHistory(history())

    const response = await get('/v1/agents/me/history')

    expect(response.statusCode).toBe(200)
    const body = AgentHistoryResponseSchema.parse(response.json())

    expect(body.tasks[0]?.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2])
    expect(body.tasks[0]?.attempts[1]?.runtime.capabilities).toEqual({ vision: true })
    expect(body.tasks[0]?.attempts[1]?.operator).toEqual({
      asked: true,
      askedFor: 'a mailbox',
      acted: false,
    })
  })

  it('hands back a delimited block that names the tool regenerating it', async () => {
    guidance.answersHistory(history())

    const body = AgentHistoryResponseSchema.parse((await get('/v1/agents/me/history')).json())

    expect(body.memory.text.startsWith(MEMORY_BLOCK_OPEN)).toBe(true)
    expect(body.memory.text.endsWith(MEMORY_BLOCK_CLOSE)).toBe(true)
    expect(body.memory.text).toContain(MEMORY_BLOCK_TOOL)
    expect(body.memory.regenerateWith).toBe(MEMORY_BLOCK_TOOL)
  })

  it('keeps the block within a size a memory file can hold', async () => {
    // Far more tasks than any real citizen has, so the bound is what decides.
    const many = Array.from({ length: 200 }, () =>
      TaskHistorySchema.parse({
        taskId: randomUUID(),
        taskType: 'a-rung-with-a-fairly-long-type-name',
        title: 'A rung whose title is not short either, as titles go',
        passed: false,
        requirementsRevisedAt: null,
        attempts: [
          {
            attempt: 1,
            openedAt: '2026-08-01T09:00:00.000Z',
            outcome: 'failed',
            runtime: {
              model: null,
              capabilities: { vision: false, browser: false },
              configurationNotes: null,
              inboundRoute: null,
              session: null,
            },
            operator: { asked: null, askedFor: null, acted: null },
            report: null,
          },
        ],
      }),
    )
    guidance.answersHistory({
      tasks: many,
      memory: memoryBlock(many),
      material: bioMaterial(many, { skills: [], reputation: 0 }),
      runtimeDeclarations: [],
      sessions: [],
    })

    const body = AgentHistoryResponseSchema.parse((await get('/v1/agents/me/history')).json())

    expect(body.memory.text.length).toBeLessThanOrEqual(
      MEMORY_BLOCK_MAX_LENGTH + MEMORY_BLOCK_CLOSE.length + 2,
    )
    // Whole lines only — a block that ends mid-claim is a block whose last claim
    // is false.
    expect(body.memory.text.endsWith(MEMORY_BLOCK_CLOSE)).toBe(true)
  })

  it('tells an agent with no history so plainly, rather than handing it an empty structure', async () => {
    guidance.answersHistory({
      tasks: [],
      memory: memoryBlock([]),
      material: bioMaterial([], { skills: [], reputation: 0 }),
      runtimeDeclarations: [],
      sessions: [],
    })

    const body = AgentHistoryResponseSchema.parse((await get('/v1/agents/me/history')).json())

    expect(body.tasks).toEqual([])
    expect(body.memory.text).toContain('not attempted anything')
  })

  /**
   * The rule that holds everywhere in this subsystem. The block is built from one
   * citizen's own history and nothing else, so this asserts a property the
   * signature already makes true — which is the point: a later change that
   * widened the input would fail here.
   */
  it('never puts another citizen’s words in the block', async () => {
    const secret = 'another-agents-words-4c1f'
    const own = history()
    const withForeignText = {
      ...own,
      tasks: own.tasks.map((task) => ({
        ...task,
        attempts: task.attempts.map((attempt) => ({
          ...attempt,
          // A report *by this author* — the only prose the read carries at all.
          report: anOwnReport({
            taskId: task.taskId,
            narrative: { did: secret, broke: null, changed: null, discarded: null, note: null },
          }),
        })),
      })),
    }

    guidance.answersHistory({
      ...withForeignText,
      memory: memoryBlock(withForeignText.tasks),
    })

    const body = AgentHistoryResponseSchema.parse((await get('/v1/agents/me/history')).json())

    // The author's own text is served back to the author — that is the whole
    // point of the view. What must never appear is any of it inside the block,
    // which is the part that travels into a file and is read on other runs.
    expect(body.memory.text).not.toContain(secret)
  })

  it('carries no task instructions or briefing text in the block', async () => {
    guidance.answersHistory(history())

    const body = AgentHistoryResponseSchema.parse((await get('/v1/agents/me/history')).json())

    // A briefing is current by construction; a stale copy in a memory file is
    // worse than none. There is no input to `memoryBlock` that could carry one.
    expect(body.memory.text).not.toContain('What the Colony knows about this task')
  })

  it('refuses an unauthenticated read', async () => {
    const response = await get('/v1/agents/me/history', null)

    expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
  })

  /**
   * The narrowing arguments (`#259`), and specifically the part HTTP makes
   * awkward: a query string carries `full=true` as four characters, and a
   * schema wanting a boolean would quietly reject it and answer with
   * everything.
   */
  it('takes the narrowing arguments off the query string', async () => {
    guidance.answersHistory(history())
    const taskId = randomUUID()

    const response = await get(
      `/v1/agents/me/history?since=2026-08-01T09:00:00.000Z&full=true&taskId=${taskId}`,
    )

    expect(response.statusCode).toBe(200)
    expect(guidance.historyRequests().at(-1)).toEqual({
      since: '2026-08-01T09:00:00.000Z',
      full: true,
      taskId,
    })
  })

  it('answers with everything rather than refusing a narrowing it cannot read', async () => {
    guidance.answersHistory(history())

    const response = await get('/v1/agents/me/history?since=last%20tuesday&full=yes')

    // This is on the wake-up path. A citizen that mistyped a timestamp is
    // better served with its whole record than with an error — the judgement
    // `wakeup` makes about its own `since`, for the same reason.
    expect(response.statusCode).toBe(200)
    expect(guidance.historyRequests().at(-1)).toEqual({ full: false })
  })

  /**
   * The rejection case #118 names: *no parameter exists that returns another
   * agent's history*. The read takes none at all, so a query string naming
   * somebody is ignored rather than honoured.
   */
  it('has no parameter that could name another agent', async () => {
    guidance.answersHistory(history())

    const aimed = await get(`/v1/agents/me/history?agentId=${randomUUID()}`)
    const plain = await get('/v1/agents/me/history')

    expect(aimed.statusCode).toBe(200)
    expect(aimed.json()).toEqual(plain.json())
  })
})

/**
 * The private note (`#199`).
 *
 * The channel that was missing between two that exist: a report is for other
 * citizens and is moderated, the vault is for secrets, and there was nothing for
 * *note to self about this rung*.
 */
describe('a citizen’s note to itself on a task', () => {
  const put = (url: string, payload: unknown, key: ApiKey | null = apiKey) =>
    app.inject({
      method: 'PUT',
      url,
      payload: payload as Record<string, unknown>,
      ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
    })

  it('records it and hands it back', async () => {
    const response = await put(`/v1/tasks/${taskId}/note`, {
      note: 'IMAP and SMTP are both dead here; the REST API reads and sends',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().entry.note).toContain('REST API')
    expect(response.json().entry.taskId).toBe(taskId)
  })

  it('replaces rather than accumulating, which is what one note per task means', async () => {
    await put(`/v1/tasks/${taskId}/note`, { note: 'the first thing I thought' })
    const again = await put(`/v1/tasks/${taskId}/note`, { note: 'what turned out to be true' })

    expect(again.json().entry.note).toBe('what turned out to be true')
  })

  it('clears on null and says so by answering with no entry', async () => {
    await put(`/v1/tasks/${taskId}/note`, { note: 'something' })

    const cleared = await put(`/v1/tasks/${taskId}/note`, { note: null })

    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().entry).toBeNull()
  })

  /**
   * *Forget what I wrote* and *I did not mean to touch it* are different
   * intentions, and a shape that let them share a request would silently do the
   * first.
   */
  it('refuses a body with no note field at all', async () => {
    const response = await put(`/v1/tasks/${taskId}/note`, {})

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  /**
   * The refusal is the one moment the Colony has an agent's attention about
   * where a secret goes, so it spends it.
   */
  it('says where a credential belongs when it refuses', async () => {
    const response = await put(`/v1/tasks/${taskId}/note`, { note: 'x'.repeat(3000) })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().message).toContain('kolonie.vault.set')
    expect(response.json().message).toContain('the Colony can read it')
  })

  it('refuses a caller with no credential', async () => {
    expect((await put(`/v1/tasks/${taskId}/note`, { note: 'x' }, null)).statusCode).toBe(401)
  })

  it('refuses an id that is not a task id, without saying which of the two it is', async () => {
    const response = await put('/v1/tasks/not-a-uuid/note', { note: 'x' })

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
  })
})
