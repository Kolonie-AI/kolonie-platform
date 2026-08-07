import { API_BASE_PATH, AttestationSchema } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'

/**
 * The one question, over the wire (`#519`).
 *
 * **What is asserted against the router rather than against a sentence** is that nothing
 * enumerates — the criterion the issue names as the one that erodes into a later
 * convenience, and the same discipline `citizens.test.ts` applies to the same temptation.
 */

let app: FastifyInstance
let colony: FakeColony

beforeEach(async () => {
  colony = fakeColony()
  app = buildApp(colony)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const ask = (path: string) => app.inject({ method: 'GET', url: `${API_BASE_PATH}${path}` })

describe('asking whether the holder of an identifier holds a skill', () => {
  it('answers a stranger presenting nothing', async () => {
    const response = await ask('/attestations/github/colette/mailbox')

    expect(response.statusCode).toBe(200)
    expect(() => AttestationSchema.parse(response.json())).not.toThrow()
    // The whole point: no credential. A party deciding whether to trust an agent needs
    // no relationship with the Colony to check.
    expect(response.json()).toEqual({ holds: false, grantedAt: null, accountProvedBy: null })
  })

  it('answers 200 whether the answer is yes or no', async () => {
    /**
     * **A `404` for *no* would put the oracle back on the wire.** The single answer shape
     * exists so a caller cannot tell *this identifier is nobody's* from *this citizen
     * declined to be asked about* from *this citizen lacks the skill* — and a status code
     * distinguishing them would undo that without touching the body.
     */
    expect((await ask('/attestations/github/nobody-at-all/mailbox')).statusCode).toBe(200)
  })

  it('lets a browser make the call', async () => {
    const response = await ask('/attestations/github/colette/mailbox')

    // The reader is a third party's own page deciding whether to let an agent in.
    expect(response.headers['access-control-allow-origin']).toBe('*')
  })

  it('refuses a skill or a kind that could not be one', async () => {
    // A malformed slug is a typo and telling a caller so leaks nothing: the vocabulary is
    // public. A *well-formed* unknown one is answered `no`, because refusing that would
    // say which skills exist.
    // 422 rather than 400: `ERROR_STATUS` maps `validation_failed` there, which is this
    // API's own convention rather than something this route chose.
    expect((await ask('/attestations/GitHub/colette/mailbox')).statusCode).toBe(422)
    expect((await ask('/attestations/github/colette/Not%20A%20Skill')).statusCode).toBe(422)
    expect((await ask('/attestations/github/colette/never-a-skill-here')).statusCode).toBe(200)
  })

  it('has no route that enumerates anything', () => {
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
    /**
     * Every collection shape somebody would reach for: the surface itself, a skill's
     * holders, and everything one identifier holds. `governance/privacy.md` refuses the
     * directory version of this, and the refusal has to be checkable rather than stated.
     */
    const collections = [
      '/v1/attestations',
      '/v1/attestations/',
      '/v1/attestations/github',
      '/v1/attestations/github/colette',
      '/v1/attestations/skills/mailbox',
    ]

    for (const url of collections) {
      for (const method of METHODS) {
        expect(app.hasRoute({ method, url })).toBe(false)
      }
    }
  })

  /**
   * The guard on the guard, on `citizens.test.ts`'s reasoning: a probe that could not
   * find the route it was written around would report *no directory exists* about a
   * router it was asking wrongly.
   */
  it('finds the one route it is written around', () => {
    expect(app.hasRoute({ method: 'GET', url: '/v1/attestations/:kind/:identifier/:skill' })).toBe(
      true,
    )
  })
})
