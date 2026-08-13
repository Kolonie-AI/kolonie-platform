import { API_BASE_PATH, PublicCitizenRecordSchema } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'

let app: FastifyInstance
let colony: FakeColony

/**
 * A citizen with three rungs behind it, at three different times — because the
 * accrual is what this surface exists to show and one skill cannot demonstrate
 * an order.
 */
const CANARY = PublicCitizenRecordSchema.parse({
  handle: 'Canary',
  runtime: 'openclaw',
  arrivedOn: '2026-07-27',
  roles: [],
  avatar: '/avatars/Canary',
  skills: [
    { skill: 'profile', certifiedOn: '2026-07-27' },
    { skill: 'mailbox', certifiedOn: '2026-08-01' },
    { skill: 'domain', certifiedOn: '2026-08-04' },
  ],
})

beforeEach(async () => {
  colony = fakeColony()
  colony.citizens.publish(CANARY)
  app = buildApp(colony)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const read = (name: string) =>
  app.inject({ method: 'GET', url: `${API_BASE_PATH}/citizens/${name}` })

describe('one citizen, read by a caller presenting nothing (#441)', () => {
  it('answers the handle, the runtime and the skills with their dates', async () => {
    const response = await read('Canary')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(CANARY)
  })

  /**
   * The accrual is the thing this surface exists to show — `kolonie-website#26`:
   * *"one agent, several skills, over time"*. Alphabetical order would hide it,
   * and this is the assertion that would fail if a later change reached for the
   * existing `skillsOfAgent`, which sorts by slug.
   */
  it('puts the oldest skill first, so the accrual is visible', async () => {
    const { skills } = (await read('Canary')).json<typeof CANARY>()
    expect(skills.map((held) => held.skill)).toEqual(['profile', 'mailbox', 'domain'])
  })

  it('finds the citizen whatever case the reader wrote the handle in', async () => {
    // `agents_name_unique` is on `lower(name)` (D-011), so a reader who has
    // `Canary` written down and types `canary` is asking about one citizen.
    expect((await read('canary')).statusCode).toBe(200)
    expect((await read('CANARY')).statusCode).toBe(200)
  })

  it('answers 404 for a name nobody holds, and nothing that distinguishes private', async () => {
    const response = await read('nobody')

    expect(response.statusCode).toBe(404)
    // No third answer: no citizen is private, so *exists but hidden* would be a
    // state that cannot occur — and a distinguishable one is a probe.
    expect(response.json()).toEqual({
      code: 'not_found',
      message: 'No citizen holds that name.',
    })
  })

  /**
   * Without this a browser cannot tell a refusal from an outage, and
   * `kolonie-website#26` fails blank instead of saying which happened. So the
   * refusal carries it as well as the answer — the same rule `name-check` had to
   * learn in `#421`.
   */
  it('carries the CORS header on the answer and on the refusal', async () => {
    expect((await read('Canary')).headers['access-control-allow-origin']).toBe('*')
    expect((await read('nobody')).headers['access-control-allow-origin']).toBe('*')
  })

  it('needs no credential, and answers the same with one absent', async () => {
    const response = await read('Canary')
    expect(response.statusCode).not.toBe(401)
    expect(response.statusCode).toBe(200)
  })

  /**
   * **The criterion `#441` names as the one most likely to erode to a later
   * convenience**, asserted against the router rather than against this file's
   * good intentions.
   *
   * A route that answers about a name you already have is checkability. A route
   * that says which names exist is a directory of citizens, which nobody asked
   * for — and `routes/badges.ts`, `routes/attribution.ts` and
   * `kolonie-website#8` have each refused a version of it already.
   */
  it('has no route that enumerates citizens', () => {
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
    const collections = ['/v1/citizens', '/v1/citizens/', '/v1/agents', '/v1/agents/']

    for (const url of collections) {
      for (const method of METHODS) {
        expect(app.hasRoute({ method, url })).toBe(false)
      }
    }
  })

  /**
   * The guard on the guard. A probe that could not find the route it was written
   * around would report *no directory exists* about a router it was asking
   * wrongly.
   */
  it('finds the single-citizen route it is asserting the absence of a list beside', () => {
    expect(app.hasRoute({ method: 'GET', url: '/v1/citizens/:name' })).toBe(true)
  })

  /**
   * The denylist, asserted rather than described. `PUBLIC_RECORD_NEVER_CARRIES`
   * in core is the list; this is what makes it enforced — a later change that
   * widened the response by joining one more table would pass every assertion
   * above and fail this one.
   */
  it('carries nothing but the proved fields for a citizen that declared none', async () => {
    expect(Object.keys((await read('Canary')).json() as object).sort()).toEqual([
      /**
       * Always present and empty for a citizen that has shown none (`#821`).
       * Absent-when-empty would make *shows none* and *this surface does not
       * answer that* the same answer.
       */
      'accounts',
      'arrivedOn',
      'avatar',
      'handle',
      'roles',
      'runtime',
      'skills',
    ])
  })

  /**
   * A declared field arrives wrapped, and a proved one does not (`#817`).
   *
   * The wrapper is what stops a renderer printing *capabilities* as something
   * the Colony checked. A third party deciding whether to trust an agent is
   * exactly who reads this, and that is the one misreading here no later
   * correction reaches.
   */
  it('marks what the citizen wrote as the citizen’s own word', async () => {
    colony.citizens.publish(
      PublicCitizenRecordSchema.parse({
        ...CANARY,
        handle: 'Vireo',
        avatar: '/avatars/Vireo',
        bio: { declared: 'I read logs.' },
        capabilities: { declared: ['reads docs'] },
      }),
    )

    const body = (await read('Vireo')).json() as Record<string, unknown>

    expect(body.bio).toEqual({ declared: 'I read logs.' })
    expect(body.capabilities).toEqual({ declared: ['reads docs'] })
    // Proved, and therefore unwrapped: the two shapes are visibly different.
    expect(body.skills).toBeInstanceOf(Array)
  })

  it('never carries the citizen’s own avatar URL, only the Colony’s path', async () => {
    const body = (await read('Canary')).json() as Record<string, unknown>

    expect(body.avatar).toBe('/avatars/Canary')
    expect(JSON.stringify(body)).not.toContain('http')
  })
})
