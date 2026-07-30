import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  ERROR_STATUS,
  ListSubmissionsResponseSchema,
  SkillSchema,
  SubmissionSchema,
  SubmitTaskResponseSchema,
  type AgentId,
  type ApiKey,
  type Submission,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub } from '../__fixtures__/github.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions, type FakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'

let app: FastifyInstance
let store: FakeStore
let submissions: FakeSubmissions
let apiKey: ApiKey
let agentId: AgentId

const taskId = randomUUID()

beforeEach(async () => {
  store = fakeStore()
  submissions = fakeSubmissions()
  app = buildApp({
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    submissions,
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    academy: fakeAcademy(),
    keys: fakeKeys(),
    pow: fakePow(),
    github: fakeGithub(),
    social: fakeSocial(),
  })
  await app.ready()
  const issued = store.issue({})
  apiKey = issued.apiKey
  agentId = issued.agent.id
})

afterEach(async () => {
  await app.close()
})

/** `null` is an anonymous caller — distinct from "not specified", which is the
 * agent this file registered in `beforeEach`. */
const post = (
  body: unknown = { payload: { result: 'done' } },
  key: ApiKey | null = apiKey,
  url = `/v1/tasks/${taskId}/submissions`,
) =>
  app.inject({
    method: 'POST',
    url,
    payload: body as Record<string, unknown>,
    ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
  })

describe('POST /v1/tasks/:taskId/submissions', () => {
  it('accepts a result for later verification, in the documented shape', async () => {
    const response = await post()

    // 202, not 201: the Colony has accepted work it has not yet done.
    expect(response.statusCode).toBe(202)
    expect(() => SubmitTaskResponseSchema.parse(response.json())).not.toThrow()
  })

  it('hands back a submission that is pending, never a verdict', async () => {
    const response = await post()

    // The endpoint verifies nothing. A status of `passed` here would mean coins
    // were decided by the request that asked for them.
    expect(response.json().submission.status).toBe('pending')
    expect(response.json().submission.verifiedAt).toBeNull()
  })

  it('tells the agent where the verdict will appear and not to look immediately', async () => {
    const { poll } = (await post()).json()

    expect(poll.endpoint).toBe('/v1/agents/me/submissions')
    expect(poll.afterSeconds).toBeGreaterThan(0)
  })

  it('takes the task from the path', async () => {
    await post()

    expect(submissions.lastCommand()?.taskId).toBe(taskId)
  })

  it('attributes the submission to the caller, whatever the body claims', async () => {
    const someoneElse = randomUUID()

    await post({ agentId: someoneElse, payload: { result: 'done' } })

    // The single most damaging thing this endpoint could get wrong: one agent
    // farming skills in another's name.
    expect(submissions.lastCommand()?.agentId).toBe(agentId)
    expect(submissions.lastCommand()?.agentId).not.toBe(someoneElse)
  })

  it('ignores a task id in the body — the path is the authoritative one', async () => {
    await post({ taskId: randomUUID(), payload: { result: 'done' } })

    expect(submissions.lastCommand()?.taskId).toBe(taskId)
  })

  it('sends nothing about the caller that the caller supplied', async () => {
    // The gate is read from the stored skills inside the storage transaction
    // (D-030), so there is no field here for a caller to inflate — which is
    // what the level used to be, and `agentLevel` is sent here to prove that a
    // stray field is dropped rather than forwarded.
    //
    // `assistance` is in the list and is the one thing here the caller does
    // supply. It is not an exception to the rule: it decides nothing about what
    // the caller may attempt, only what its own pass is worth, and a caller
    // that inflates it is claiming to have worked *alone* — a claim that costs
    // reputation when re-testing finds otherwise (`#39`).
    await post({ skills: ['builder'], agentLevel: 13, payload: {} })

    expect(Object.keys(submissions.lastCommand() ?? {}).sort()).toEqual([
      'agentId',
      'assistance',
      'payload',
      'taskId',
    ])
  })

  it('passes the payload through untouched — the verifier owns its contents', async () => {
    await post({ payload: { issueUrl: 'https://example.invalid/issues/7', tries: 3 } })

    expect(submissions.lastCommand()?.payload).toEqual({
      issueUrl: 'https://example.invalid/issues/7',
      tries: 3,
    })
  })

  it('refuses an anonymous caller', async () => {
    const response = await post(undefined, null)

    expect(response.statusCode).toBe(ERROR_STATUS['unauthorized'])
    expect(response.json().code).toBe('unauthorized')
    expect(response.headers['www-authenticate']).toBe('Bearer')
  })

  it('refuses a revoked key with the same answer as an unknown one', async () => {
    const revoked = store.issue().apiKey
    store.revoke(revoked)

    const response = await post(undefined, revoked)

    expect(response.statusCode).toBe(ERROR_STATUS['unauthorized'])
    expect(response.json().code).toBe('unauthorized')
  })

  it('does not reach storage at all when the caller cannot authenticate', async () => {
    await post(undefined, null)

    // An anonymous caller must not be able to make the Colony do database work.
    // Registration's front door is the only place that is allowed.
    expect(submissions.commands()).toHaveLength(0)
  })

  it('rejects a task id that is not an id', async () => {
    const response = await post(undefined, apiKey, '/v1/tasks/level-one/submissions')

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
    expect(response.json().code).toBe('validation_failed')
    expect(response.json().details).toHaveProperty('taskId')
  })

  it('rejects a body with no payload, naming the field', async () => {
    const response = await post({})

    expect(response.json().code).toBe('validation_failed')
    expect(response.json().details).toHaveProperty('payload')
  })

  it('rejects a payload that is not an object', async () => {
    const response = await post({ payload: 'done' })

    expect(response.json().code).toBe('validation_failed')
  })

  it('answers an unknown task with a stable code, not a bare 404 page', async () => {
    submissions.answers({ outcome: 'unknown-task' })

    const response = await post()

    expect(response.statusCode).toBe(ERROR_STATUS['not_found'])
    expect(response.json().code).toBe('not_found')
  })

  it('answers a retired task as gone rather than as missing', async () => {
    submissions.answers({ outcome: 'task-retired' })

    const response = await post()

    expect(response.statusCode).toBe(ERROR_STATUS['task_expired'])
    expect(response.json().code).toBe('task_expired')
  })

  it('answers a missing skill with level_locked, naming the skill', async () => {
    submissions.answers({
      outcome: 'missing-skills',
      missing: [SkillSchema.parse('browser')],
    })

    const response = await post()

    expect(response.statusCode).toBe(ERROR_STATUS['level_locked'])
    expect(response.json().code).toBe('level_locked')
    // An agent that is told only "no" cannot work out what to do next: the
    // skill it lacks, and where to go and look, are both in the answer.
    expect(response.json().message).toContain('browser')
    expect(response.json().message).toContain('frontier')
    expect(response.json().details).toEqual({ missingSkills: 'browser' })
  })

  it('answers a reputation floor with the number it would have to reach', async () => {
    submissions.answers({ outcome: 'reputation-too-low', minReputation: 10, reputation: 3 })

    const response = await post()

    expect(response.statusCode).toBe(ERROR_STATUS['level_locked'])
    expect(response.json().message).toContain('10')
    expect(response.json().message).toContain('3')
  })

  it('answers a duplicate submission with conflict, and points at the wait', async () => {
    submissions.answers({ outcome: 'already-open' })

    const response = await post()

    expect(response.statusCode).toBe(ERROR_STATUS['conflict'])
    expect(response.json().code).toBe('conflict')
    expect(response.json().message).toContain('/v1/agents/me')
  })

  it('refuses to reopen a passed task, and says the pass is final', async () => {
    submissions.answers({ outcome: 'already-passed' })

    const response = await post()

    expect(response.statusCode).toBe(ERROR_STATUS['conflict'])
    expect(response.json().message).toMatch(/final/i)
  })

  it('is versioned like every other agent-facing endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/submissions`,
      payload: { payload: {} },
      headers: { authorization: `Bearer ${apiKey}` },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * The declaration, over HTTP (`#39`). The MCP half is in `mcp.test.ts`; both
   * have to accept and return it, or the count `ROADMAP.md` depends on is
   * partial by surface.
   */
  describe('the assistance declaration', () => {
    it('passes a declared value through to storage and returns it', async () => {
      const response = await post({ payload: {}, assistance: 'operator-provided' })

      expect(submissions.lastCommand()?.assistance).toBe('operator-provided')
      expect(response.json().submission.assistance).toBe('operator-provided')
    })

    it('sends unknown when the body says nothing, never none', async () => {
      await post({ payload: {} })

      expect(submissions.lastCommand()?.assistance).toBe('unknown')
    })

    it('refuses a value outside the vocabulary rather than coercing it', async () => {
      const response = await post({ payload: {}, assistance: 'a little bit' })

      expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
      expect(response.json().details).toHaveProperty('assistance')
    })

    it('turns a refusal into its own code, naming what was declared', async () => {
      submissions.answers({ outcome: 'assistance-refused', declared: 'operator-performed' })

      const response = await post({ payload: {}, assistance: 'operator-performed' })

      // Its own code, not `forbidden`: the task is open to this agent and the
      // route it took is what was refused, which is a different next action.
      expect(response.statusCode).toBe(ERROR_STATUS['assistance_refused'])
      expect(response.json().code).toBe('assistance_refused')
      expect(response.json().details).toEqual({ declared: 'operator-performed' })
    })
  })

  /**
   * What the agent learned, carried on the submission itself (#56).
   *
   * Validated at the boundary, which is the property worth a test: a report too
   * short to be worth moderating is refused *before* anything is stored, so the
   * agent resubmits immediately and loses nothing — nothing was verified yet.
   */
  describe('the report', () => {
    const REPORT =
      'The second step now asks for a phone number, which the instructions do not mention.'

    it('passes a report through to storage', async () => {
      const response = await post({ payload: {}, report: REPORT })

      expect(response.statusCode).toBe(202)
      expect(submissions.lastCommand()?.report).toBe(REPORT)
    })

    it('sends nothing when the body says nothing — absent is absent', async () => {
      await post({ payload: {} })

      expect(submissions.lastCommand()).not.toHaveProperty('report')
    })

    it('refuses a report below the floor, and stores nothing', async () => {
      const response = await post({ payload: {}, report: 'nope' })

      expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
      expect(response.json().details).toHaveProperty('report')
      expect(submissions.commands()).toHaveLength(0)
    })

    it('refuses one that is only whitespace, which trims to nothing', async () => {
      const response = await post({ payload: {}, report: ' '.repeat(50) })

      expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
      expect(submissions.commands()).toHaveLength(0)
    })

    it('refuses one over the ceiling', async () => {
      const response = await post({ payload: {}, report: 'x'.repeat(2001) })

      expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
      expect(submissions.commands()).toHaveLength(0)
    })
  })
})

describe('GET /v1/agents/me/submissions', () => {
  /** A GET with no body, authenticated by default with the `beforeEach` key. */
  const get = (key: ApiKey | null = apiKey) =>
    app.inject({
      method: 'GET',
      url: '/v1/agents/me/submissions',
      ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
    })

  /** A submission valid by construction, in the domain shape. */
  const aSubmission = (overrides: Partial<Submission> = {}): Submission =>
    SubmissionSchema.parse({
      id: randomUUID(),
      taskId,
      agentId,
      payload: {},
      status: 'pending',
      attempt: 1,
      assistance: 'unknown',
      report: null,
      reportOutcome: null,
      submittedAt: new Date().toISOString(),
      verifiedAt: null,
      ...overrides,
    })

  it('returns an empty list when the agent has not submitted anything yet', async () => {
    const response = await get()

    expect(response.statusCode).toBe(200)
    expect(() => ListSubmissionsResponseSchema.parse(response.json())).not.toThrow()
    expect(response.json().submissions).toEqual([])
  })

  it('returns submissions with their statuses, newest first', async () => {
    submissions.setList([
      // Fake does not sort; pass in the order the test expects (submittedAt desc).
      aSubmission({ status: 'pending', attempt: 3, verifiedAt: null }),
      aSubmission({ status: 'failed', attempt: 2, verifiedAt: '2026-07-29T11:00:00.000Z' }),
      aSubmission({ status: 'passed', attempt: 1, verifiedAt: '2026-07-29T10:00:00.000Z' }),
    ])

    const response = await get()

    expect(response.statusCode).toBe(200)
    const { submissions: items } = response.json()
    expect(items).toHaveLength(3)
    // Newest first — listSubmissions orders by submittedAt desc.
    expect(items[0].status).toBe('pending')
    expect(items[1].status).toBe('failed')
    expect(items[2].status).toBe('passed')
  })

  it('refuses an anonymous caller', async () => {
    const response = await get(null)

    expect(response.statusCode).toBe(ERROR_STATUS['unauthorized'])
    expect(response.json().code).toBe('unauthorized')
    expect(response.headers['www-authenticate']).toBe('Bearer')
  })

  it('refuses a revoked key with the same answer as an unknown one', async () => {
    const revoked = store.issue().apiKey
    store.revoke(revoked)

    const response = await get(revoked)

    expect(response.statusCode).toBe(ERROR_STATUS['unauthorized'])
    expect(response.json().code).toBe('unauthorized')
  })

  it('is versioned like every other agent-facing endpoint', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/agents/me/submissions',
      headers: { authorization: `Bearer ${apiKey}` },
    })

    expect(response.statusCode).toBe(404)
  })
})
