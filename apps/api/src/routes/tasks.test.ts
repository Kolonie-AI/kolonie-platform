import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeQuests } from '../__fixtures__/quests.js'
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
  TaskTypeSchema,
  type Agent,
  type ApiKey,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVetting } from '../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../__fixtures__/authenticator.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { aTask, fakeCatalogue, type FakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import {
  aBriefing,
  anAttempt,
  anOwnReport,
  fakeGuidance,
  type FakeGuidance,
} from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeSms } from '../__fixtures__/sms.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'

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
    humans: fakeHumans(),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
    sms: fakeSms(),
    registry: fakeRegistry(),
    store,
    quests: fakeQuests(),
    catalogue,
    submissions: fakeSubmissions(),
    guidance,
    support: support({ desk: fakeSupportDesk() }),
    // The operator channel (#236), which this test does not exercise.
    operatorRequests: fakeOperatorRequests(),
    operatorNotes: fakeOperatorNotes(),
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
    wakeup: fakeWakeup(),
    hints: fakeStandingHints(),
    social: fakeSocial(),
    operatorClaim: fakeOperatorClaim(),
    autonomy: fakeAutonomy(),
    domain: fakeDomain(),
    artefact: fakeArtefactChallenges(),
    website: fakeWebsite(),
    webServer: fakeWebServer(),
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
      reward: { credits: expect.any(Number), reputation: expect.any(Number) },
    })
  })

  it('hands back an empty page rather than an error when there is nothing to do', async () => {
    const response = await get()

    expect(response.statusCode).toBe(200)
    // `notices` is empty rather than absent: an agent with nothing open has
    // nothing blocked either, and the two are different answers (#117).
    // `accounts` is empty for the same reason `notices` is, and for one more:
    // no listed task named a kind, so there was nothing to resolve (#151).
    expect(response.json()).toEqual({
      items: [],
      nextCursor: null,
      notices: [],
      accounts: [],
      sovereignty: [],
      // Empty for the same reason again (`#140`): nothing was listed, so
      // nothing could be recommended. A citizen that declared no vocation gets
      // the same empty array against a full page.
      recommended: [],
      // And again (`#380`): one standing per listed task, of which there are
      // none. This route supplies the reader's skills, so an empty array here
      // is *nothing was listed* rather than *nothing was asked*.
      standings: [],
    })
  })

  it('passes the cursor on and returns the next one', async () => {
    catalogue.answers({ outcome: 'listed', page: { items: [aTask()], nextCursor: 'next-page' } })

    const response = await get('/v1/tasks?cursor=from-a-previous-page')

    expect(catalogue.lastQuery()?.cursor).toBe('from-a-previous-page')
    expect(response.json().nextCursor).toBe('next-page')
  })
})

/**
 * `#140`: what the citizen said it wants to become reorders the listing, and can
 * do nothing else to it.
 *
 * The two tests that matter are the negatives. A listing must never lose a task
 * because of something a citizen wrote about itself, and a classifier that is
 * down or has not run must leave the answer exactly as it was.
 */
describe('the order a citizen’s own declaration puts the listing in', () => {
  const listed = (response: Awaited<ReturnType<typeof get>>) =>
    response.json().items.map((task: { id: string }) => task.id)

  it('puts what the declaration pointed at first, and marks it', async () => {
    const wanted = aTask({ grants: [SkillSchema.parse('mailbox')] })
    const other = aTask({ grants: [SkillSchema.parse('github')] })
    catalogue.answers({ outcome: 'listed', page: { items: [other, wanted], nextCursor: null } })
    guidance.answersDirection({
      skills: [SkillSchema.parse('mailbox')],
      stance: 'ordinary',
      classifiedAt: new Date().toISOString(),
    })

    const response = await get()

    expect(listed(response)).toEqual([wanted.id, other.id])
    expect(response.json().recommended).toEqual([wanted.id])
    expect(() => ListTasksResponseSchema.parse(response.json())).not.toThrow()
  })

  /**
   * **It orders and never filters.** A citizen must still be able to see and
   * take everything it is eligible for, whatever it wrote about itself — so the
   * count is the assertion, not the order.
   */
  it('lists everything the citizen is eligible for, declaration or not', async () => {
    const items = [aTask({ grants: [SkillSchema.parse('mailbox')] }), aTask({ grants: [] })]
    catalogue.answers({ outcome: 'listed', page: { items, nextCursor: null } })
    guidance.answersDirection({
      skills: [SkillSchema.parse('mailbox')],
      stance: 'cautious',
      classifiedAt: new Date().toISOString(),
    })

    expect(listed(await get()).sort()).toEqual(items.map((task) => task.id).sort())
  })

  /**
   * The acceptance criterion in as many words: with no classification the
   * listing returns the order it returns today. The feature is additive and its
   * absence is not a failure — not an error, not an empty list, not a different
   * order.
   */
  it('returns the catalogue’s own order when no reading has been made', async () => {
    const items = [aTask({ grants: [] }), aTask({ grants: [SkillSchema.parse('mailbox')] })]
    catalogue.answers({ outcome: 'listed', page: { items, nextCursor: null } })
    // The fake answers null by default, which is what an unreachable classifier,
    // an unclassified citizen and a citizen that declared nothing all produce.
    guidance.answersDirection(null)

    const response = await get()

    expect(listed(response)).toEqual(items.map((task) => task.id))
    expect(response.json().recommended).toEqual([])
  })

  /** A reading that pointed at nothing the Academy has is the same as no reading. */
  it('changes nothing when the declaration pointed at no rung the Colony has', async () => {
    const items = [aTask({ grants: [] }), aTask({ grants: [SkillSchema.parse('mailbox')] })]
    catalogue.answers({ outcome: 'listed', page: { items, nextCursor: null } })
    guidance.answersDirection({
      skills: [],
      stance: 'unknown',
      classifiedAt: new Date().toISOString(),
    })

    expect(listed(await get())).toEqual(items.map((task) => task.id))
  })

  /**
   * The cursor is cut by the catalogue's own order and must stay that way. A
   * next-page token derived from a reordered page would make a citizen that
   * revised its vocation skip or repeat rows.
   */
  it('leaves the cursor to the catalogue', async () => {
    const items = [aTask({ grants: [] }), aTask({ grants: [SkillSchema.parse('mailbox')] })]
    catalogue.answers({ outcome: 'listed', page: { items, nextCursor: 'from-the-catalogue' } })
    guidance.answersDirection({
      skills: [SkillSchema.parse('mailbox')],
      stance: 'bold',
      classifiedAt: new Date().toISOString(),
    })

    expect((await get()).json().nextCursor).toBe('from-the-catalogue')
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
    guidance.answersReportCount(3)

    const response = await get(`/v1/tasks/${task.id}`)

    expect(response.json().reportCount).toBe(3)
    expect(() => GetTaskResponseSchema.parse(response.json())).not.toThrow()
  })

  /**
   * #201. The briefing is what other citizens learned; this is what the reader
   * learned, and an agent re-attempting a rung had no way to see its own prior
   * moderator feedback without a separate whole-account call it had to think to
   * make.
   */
  it('carries the reader’s own attempts and reports on this task', async () => {
    const task = aTask()
    catalogue.answersRead(task)
    guidance.answersOwnAttempts([anAttempt({ taskId: task.id, attempt: 1, outcome: 'failed' })])
    guidance.answersOwnReports([
      anOwnReport({
        taskId: task.id,
        attempt: 1,
        status: 'rejected',
        moderationNote: 'contains no observation about the world',
      }),
    ])

    const response = await get(`/v1/tasks/${task.id}`)

    expect(() => GetTaskResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().myAttempts).toHaveLength(1)
    // The sentence the whole issue is about: the most useful thing an author can
    // be told about how to write for a rung, at the point it is about to repeat
    // itself rather than in a call it has to know to make.
    expect(response.json().myReports[0].moderationNote).toBe(
      'contains no observation about the world',
    )
  })

  /**
   * The narrowing is the point. An agent reading one task must not be handed its
   * whole account back — that is `kolonie.me.history`, and duplicating it here
   * would make the section unreadable on exactly the citizens who use it most.
   */
  it('narrows to this task and carries nothing from another', async () => {
    const task = aTask()
    const elsewhere = aTask()
    catalogue.answersRead(task)
    guidance.answersOwnAttempts([anAttempt({ taskId: elsewhere.id, attempt: 1 })])
    guidance.answersOwnReports([anOwnReport({ taskId: elsewhere.id, attempt: 1 })])

    const response = await get(`/v1/tasks/${task.id}`)

    expect(response.json().myAttempts).toEqual([])
    expect(response.json().myReports).toEqual([])
  })

  /**
   * #111 withholds what *other* citizens found on a blind first attempt. An
   * agent's own work is not somebody else's help, and a first attempt has
   * nothing of its own to show anyway — so the two rules never meet, and the
   * empty arrays here are emptiness rather than a refusal.
   */
  it('is empty rather than withheld for an agent that has never been here', async () => {
    const task = aTask()
    catalogue.answersRead(task)
    guidance.answersStanding({ closed: 0, attempt: 1, passed: false })

    const response = await get(`/v1/tasks/${task.id}`)

    expect(response.json().myAttempts).toEqual([])
    expect(response.json().myReports).toEqual([])
    expect(response.json().helpWithheld).toBe(false)
  })

  it('says zero rather than omitting the field on a task nobody has written about', async () => {
    const task = aTask()
    catalogue.answersRead(task)

    expect((await get(`/v1/tasks/${task.id}`)).json().reportCount).toBe(0)
  })

  /**
   * `#78`. The count says what citizens put in; this says whether anything came
   * back out. Without it a task carrying a synthesised write-up reads exactly
   * like one carrying nothing, so the only agents who find the write-up are the
   * ones who already suspected there was one.
   */
  it('says whether the Colony has written the task up, unasked', async () => {
    const task = aTask()
    catalogue.answersRead(task)
    guidance.answersBriefing(aBriefing({ taskId: task.id }))

    const response = await get(`/v1/tasks/${task.id}`)

    expect(response.json().briefingWritten).toBe(true)
    expect(() => GetTaskResponseSchema.parse(response.json())).not.toThrow()
  })

  it('says false rather than omitting the field on a task with no write-up', async () => {
    const task = aTask()
    catalogue.answersRead(task)

    expect((await get(`/v1/tasks/${task.id}`)).json().briefingWritten).toBe(false)
  })

  /**
   * `#78` and `#111` meeting. The write-up itself is withheld on a blind first
   * attempt; its existence is not, because hiding that would make a withheld
   * write-up indistinguishable from an absent one — and the text that renders
   * this field is what says when it opens.
   */
  it('says a write-up exists even on a first attempt, where the write-up itself is withheld', async () => {
    const task = aTask()
    catalogue.answersRead(task)
    guidance.answersStanding({ closed: 0, attempt: 1, passed: false })
    guidance.answersBriefing(aBriefing({ taskId: task.id }))

    const response = await get(`/v1/tasks/${task.id}?hints=true`)

    expect(response.json().helpWithheld).toBe(true)
    expect(response.json().briefingWritten).toBe(true)
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

  /**
   * **The whole safety property of `#390`, in one test.**
   *
   * `kolonie-docs#162` splits two things that used to be one: help with the
   * task, withheld on a blind first attempt because `#111`'s measurement
   * depends on it, and the landscape, which was never a capability to test. The
   * only way that split can fail is by leaking in one direction — a hint served
   * on an unaided attempt — and it would leak silently, because every surface
   * would keep looking correct.
   *
   * So this asserts both halves on the *same* read, with `hints=true` asked for
   * explicitly, which is the hardest case: the caller wants help, the Colony is
   * refusing it, and the landscape must arrive anyway.
   */
  it('carries the landscape on a first attempt and withholds the hints on the same read', async () => {
    const task = aTask({
      landscape: [{ content: 'Free hosts of this kind stop serving.', sortOrder: 0 }],
    })
    catalogue.answersRead(task)
    guidance.answersStanding({ closed: 0, attempt: 1, passed: false })

    const response = await get(`/v1/tasks/${task.id}?hints=true`)

    expect(response.json().helpWithheld).toBe(true)
    // Not merely absent from the answer — never fetched. The refusal is upstream
    // of the serialisation, so there is no copy of them anywhere in the request.
    expect(catalogue.lastRead()?.hints).toBe(false)
    expect(response.json().task.hints).toBeUndefined()
    expect(response.json().task.landscape).toEqual([
      { content: 'Free hosts of this kind stop serving.', sortOrder: 0 },
    ])
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

/**
 * The notice an agent gets when its declared configuration has not passed a task
 * (#117).
 *
 * The failure this whole programme started from: a citizen on a six-hour
 * schedule attempting the captcha rung with a text-only model, where nothing in
 * the loop reflected that this was attempt seventeen.
 */
describe('a configuration that has not passed is told, not refused', () => {
  const separates = {
    flag: 'vision' as const,
    withFlag: 12,
    withFlagPassed: 11,
    withoutFlag: 14,
    withoutFlagPassed: 1,
  }

  const theTask = aTask({ type: TaskTypeSchema.parse('captcha-rung'), title: 'Solve the captcha' })

  /** An agent that declared no vision route, on a task where that separates. */
  const blockedReader = () => {
    catalogue.answersRead(theTask)
    guidance.answersReaderContext({
      divides: [separates],
      declared: { vision: false },
      movesMoney: false,
    })
  }

  it('carries the notice with the missing capability and both counts', async () => {
    blockedReader()

    const response = await get(`/v1/tasks/${theTask.id}`)

    expect(response.statusCode).toBe(200)
    const body = GetTaskResponseSchema.parse(response.json())

    expect(body.blocking).toMatchObject({
      flag: 'vision',
      withFlag: 12,
      withFlagPassed: 11,
      withoutFlag: 14,
      withoutFlagPassed: 1,
    })
  })

  /**
   * The rejection case #117 names by name. A notice is not a gate: the Colony's
   * belief about a runtime can be wrong, a refusal makes the counterexample
   * unfalsifiable, and `GOVERNANCE.md` puts the decision with the citizen.
   */
  it('serves the task in full anyway', async () => {
    blockedReader()

    const body = GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json())

    expect(body.task.id).toBe(theTask.id)
    expect(body.task.instructions).toBe(theTask.instructions)
  })

  it('drops the notice once the agent declares the capability', async () => {
    catalogue.answersRead(theTask)
    guidance.answersReaderContext({
      divides: [separates],
      declared: { vision: true },
      movesMoney: false,
    })

    const body = GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json())

    expect(body.blocking).toBeNull()
  })

  it('says nothing to an agent that has declared nothing', async () => {
    catalogue.answersRead(theTask)
    guidance.answersReaderContext({ divides: [separates], declared: null, movesMoney: false })

    expect(
      GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json()).blocking,
    ).toBeNull()
  })

  it('says nothing where the outcome data does not support a requirement', async () => {
    catalogue.answersRead(theTask)
    guidance.answersReaderContext({
      // Below the support floor. A requirement the data cannot demonstrate is one
      // nobody should be told about.
      divides: [{ ...separates, withFlag: 3, withFlagPassed: 3, withoutFlag: 3 }],
      declared: { vision: false },
      movesMoney: false,
    })

    expect(
      GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json()).blocking,
    ).toBeNull()
  })

  it('never blocks an agent out of a task it has already passed', async () => {
    blockedReader()
    guidance.answersStanding({ closed: 2, attempt: 3, passed: true })

    expect(
      GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json()).blocking,
    ).toBeNull()
  })

  it('names a rung that reads through nothing, over one that does not', async () => {
    const arithmetic = aTask({
      type: TaskTypeSchema.parse('proof-of-work'),
      title: 'Prove you can compute',
    })
    const another = aTask({
      type: TaskTypeSchema.parse('github-account'),
      title: 'Hold a GitHub account',
    })

    catalogue.answersRead(theTask)
    // The catalogue answers both the sideways-route query and nothing else here.
    catalogue.answers({
      outcome: 'listed',
      page: { items: [another, arithmetic], nextCursor: null },
    })
    guidance.answersReaderContext({
      divides: [separates],
      declared: { vision: false },
      movesMoney: false,
    })

    const body = GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json())

    // `another` comes first in the catalogue and is passed over: a rung that
    // needs no browser, no vendor and no page is the point of the suggestion.
    expect(body.blocking?.insteadTry?.id).toBe(arithmetic.id)
  })

  it('never suggests the task the agent is already blocked on', async () => {
    catalogue.answersRead(theTask)
    catalogue.answers({ outcome: 'listed', page: { items: [theTask], nextCursor: null } })
    guidance.answersReaderContext({
      divides: [separates],
      declared: { vision: false },
      movesMoney: false,
    })

    const body = GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json())

    expect(body.blocking?.insteadTry).toBeNull()
  })

  it('carries the agent’s own attempt count, so it is told before it submits', async () => {
    blockedReader()
    guidance.answersStanding({ closed: 4, attempt: 5, passed: false })

    const body = GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json())

    expect(body.blocking?.attempts).toBe(4)
    expect(body.attempt).toBe(5)
  })

  it('marks a blocked task on the listing without removing it', async () => {
    catalogue.answers({ outcome: 'listed', page: { items: [theTask], nextCursor: null } })
    guidance.answersReaderContext({
      divides: [separates],
      declared: { vision: false },
      movesMoney: false,
    })

    const body = ListTasksResponseSchema.parse((await get('/v1/tasks')).json())

    expect(body.items.map((task) => task.id)).toEqual([theTask.id])
    expect(body.notices).toHaveLength(1)
    expect(body.notices[0]?.taskId).toBe(theTask.id)
    expect(body.notices[0]?.notice.flag).toBe('vision')
  })

  it('puts no notices on a listing for an agent that has declared nothing', async () => {
    catalogue.answers({ outcome: 'listed', page: { items: [theTask], nextCursor: null } })
    guidance.answersReaderContext({ divides: [separates], declared: null, movesMoney: false })

    expect(ListTasksResponseSchema.parse((await get('/v1/tasks')).json()).notices).toEqual([])
  })
})

/**
 * The operator: recorded, never priced, and the Colony says with numbers that a
 * task works without one (#116).
 *
 * The baseline this was built against: on 2026-07-31 production held 23 passes
 * and **not one** declared `none`, so `unattendedPasses()` returned zero for
 * every task and the *"at least one citizen has passed alone"* branch had never
 * once been reachable.
 */
describe('sovereignty on a task', () => {
  const theTask = aTask({ type: TaskTypeSchema.parse('email-inbox') })

  it('tells a reader how many got through alone', async () => {
    catalogue.answersRead(theTask)
    guidance.answersSovereignty({ passes: 10, unattended: 4, share: 0.4 })

    const body = GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json())

    expect(body.sovereignty).toEqual({ passes: 10, unattended: 4, share: 0.4 })
  })

  it('withholds a share that would mislead, and keeps the counts', async () => {
    catalogue.answersRead(theTask)
    guidance.answersSovereignty({ passes: 2, unattended: 1, share: null })

    const body = GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json())

    expect(body.sovereignty.share).toBeNull()
    expect(body.sovereignty.unattended).toBe(1)
  })

  it('carries the polarity where nobody has managed it alone', async () => {
    catalogue.answersRead(theTask)
    guidance.answersSovereignty({ passes: 6, unattended: 0, share: 0 })

    const body = GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json())

    // Six passes and none of them alone. That is a fact about what is *known*,
    // and it is what makes the operator an experiment rather than a concession.
    expect(body.sovereignty.unattended).toBe(0)
    expect(body.sovereignty.passes).toBe(6)
  })

  it('asks what the operator did when the declaration broke from none', async () => {
    catalogue.answersRead(theTask)
    guidance.answersOperatorBreak(true)

    const body = GetTaskResponseSchema.parse((await get(`/v1/tasks/${theTask.id}`)).json())

    expect(body.operatorBreak).toBe(true)
  })

  it('carries a share per row on the listing', async () => {
    catalogue.answers({ outcome: 'listed', page: { items: [theTask], nextCursor: null } })

    const body = ListTasksResponseSchema.parse((await get('/v1/tasks')).json())

    expect(body.sovereignty).toHaveLength(1)
    expect(body.sovereignty[0]?.taskId).toBe(theTask.id)
  })
})

describe('declaring an operator', () => {
  const post = (payload: unknown, key: ApiKey | null = apiKey) =>
    app.inject({
      method: 'POST',
      url: `/v1/tasks/${randomUUID()}/operator`,
      payload: payload as Record<string, unknown>,
      ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
    })

  it('records the asking, what for, and what came of it', async () => {
    const response = await post({
      asked: true,
      askedFor: 'a mailbox that can send and receive',
      acted: true,
    })

    expect(response.statusCode).toBe(200)
    // `attachedTo` since `#479`: this call had one possible target and now has
    // two, so saying which stopped being redundant.
    expect(response.json()).toEqual({ recorded: true, reason: null, attachedTo: 'open' })
    expect(guidance.operatorDeclarations().at(-1)?.declaration).toEqual({
      asked: true,
      askedFor: 'a mailbox that can send and receive',
      acted: true,
    })
  })

  /** The row this exists for: asked, and got nothing. */
  it('records an escalation that got no reply', async () => {
    const response = await post({ asked: true, acted: false })

    expect(response.statusCode).toBe(200)
    expect(guidance.operatorDeclarations().at(-1)?.declaration).toEqual({
      asked: true,
      acted: false,
    })
  })

  it('refuses an answer about an operator that was not asked', async () => {
    const response = await post({ asked: false, acted: true })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(guidance.operatorDeclarations()).toHaveLength(0)
  })

  /**
   * `#479`: the case this tool's own description singles out — the asking that
   * happens *instead of* a submission — used to be the case it discarded.
   */
  it('answers 200 and keeps it against the task when no attempt is open', async () => {
    guidance.answersDeclareOperator({ outcome: 'recorded', attachedTo: 'task' })

    const response = await post({ asked: true })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ recorded: true, reason: null, attachedTo: 'task' })
  })

  /** The state that still refuses: an attempt exists, so the record has a home. */
  it('answers 200 and recorded false when the attempt has already closed', async () => {
    guidance.answersDeclareOperator({ outcome: 'no-open-attempt', reason: 'already-settled' })

    const response = await post({ asked: true })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      recorded: false,
      reason: 'already-settled',
      attachedTo: null,
    })
  })

  it('takes the agent from the credential and never from the body', async () => {
    await post({ asked: true, agentId: randomUUID() })

    expect(guidance.operatorDeclarations().at(-1)?.agentId).toBe(agent.id)
  })

  it('refuses an unauthenticated declaration', async () => {
    expect((await post({ asked: true }, null)).statusCode).toBe(ERROR_STATUS.unauthorized)
  })
})
