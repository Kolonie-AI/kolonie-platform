import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeHumans } from '../__fixtures__/humans.js'
import type { Professions } from '../professions.js'

const CONSOLE_HOST = 'console.example'
const PUBLISHED_AT = '2026-09-12T12:00:00.000Z'
const definition = {
  key: 'software-producer',
  version: 1,
  title: 'Software Producer',
  summary: 'Builds useful software.',
  vision: 'Useful software becomes durable.',
  mission: 'Find a real problem and ship a running solution.',
  intendedImpact: 'People solve a concrete problem.',
  audience: 'People with that problem.',
  successSignals: ['Independently observable use'],
  principles: ['Own the product lifecycle'],
  failureModes: ['A graveyard of demos'],
  boundaries: ['Use only authorised systems and data'],
  workplaceOrientation: 'Carry the current product bet on the citizen-owned board.',
}

describe('/backend/professions', () => {
  let app: FastifyInstance
  let humans: ReturnType<typeof fakeHumans>
  let cookie: string
  let calls: { publish: number; retire: number; publisherId: string | null }

  beforeEach(async () => {
    humans = fakeHumans()
    calls = { publish: 0, retire: 0, publisherId: null }
    const profession = {
      key: definition.key,
      lifecycle: 'active' as const,
      currentVersion: 1,
      publishedAt: PUBLISHED_AT,
      retiredAt: null,
    }
    const publication = {
      publishedAt: profession.publishedAt,
      publishedByHumanId: null,
    }
    const professions: Professions = {
      listActive: async () => [
        {
          key: definition.key,
          title: definition.title,
          summary: definition.summary,
          version: definition.version,
        },
      ],
      listForMaintainer: async () => [{ profession, definition, publication, priorVersions: [1] }],
      read: async (_key, version) =>
        version === undefined || version === 1 ? { profession, definition, publication } : null,
      publish: async (input) => {
        calls.publish += 1
        calls.publisherId = input.publisherId
        if (input.expectedVersion !== null) return { outcome: 'conflict', currentVersion: 1 }
        return {
          outcome: 'published',
          profession,
          definition: input.definition,
          publication: { ...publication, publishedByHumanId: input.publisherId },
        }
      },
      retire: async () => {
        calls.retire += 1
        return {
          outcome: 'retired',
          profession: { ...profession, lifecycle: 'retired', retiredAt: profession.publishedAt },
        }
      },
      assign: async () => ({ outcome: 'unavailable', reason: 'not-found' }),
    }
    app = buildApp({
      ...fakeColony(),
      humans,
      professions,
      console: { ...fakeColony().console, consoleUrl: `https://${CONSOLE_HOST}` },
    })
    const human = await humans.store.findOrCreate({
      provider: 'github',
      subject: 'maintainer',
      email: null,
    })
    if (human.human === undefined) throw new Error('fixture failed to create maintainer')
    humans.store.maintains(human.human.id)
    cookie = (await humans.store.openSession(human.human.id, {})).session
  })

  afterEach(async () => app.close())

  const request = (method: 'GET' | 'POST', url: string, payload?: unknown, session = cookie) =>
    app.inject({
      method,
      url,
      payload: payload as InjectOptions['payload'],
      headers: {
        host: CONSOLE_HOST,
        accept: 'application/json',
        cookie: `__Host-kolonie_session=${session}`,
      },
    })

  it('lists current definitions and reads immutable history for maintainers', async () => {
    expect((await request('GET', '/backend/professions')).json()).toMatchObject([
      { definition, publication: { publishedAt: PUBLISHED_AT }, priorVersions: [1] },
    ])
    expect(
      (await request('GET', '/backend/professions/software-producer/versions/1')).json(),
    ).toMatchObject({ definition })
  })

  it('renders the current catalogue and immutable history for maintainers', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: '/backend/professions',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${cookie}`,
      },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.headers['content-type']).toContain('text/html')
    expect(listed.body).toContain('Software Producer')
    expect(listed.body).toContain('/backend/professions/software-producer/versions/1')

    const historical = await app.inject({
      method: 'GET',
      url: '/backend/professions/software-producer/versions/1',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${cookie}`,
      },
    })
    expect(historical.statusCode).toBe(200)
    expect(historical.body).toContain('Software Producer v1')
    expect(historical.body).toContain(definition.mission)
  })

  it('publishes and retires with the signed-in maintainer as publisher', async () => {
    const published = await request('POST', '/backend/professions/software-producer', {
      expectedVersion: null,
      definition,
    })
    expect(published.statusCode).toBe(200)
    const retired = await request('POST', '/backend/professions/software-producer/retire', {
      expectedVersion: 1,
    })
    expect(retired.statusCode).toBe(200)
    expect(calls).toEqual({ publish: 1, retire: 1, publisherId: expect.any(String) })
  })

  it('returns not found and writes nothing for a caller without the maintainer role', async () => {
    const outsider = await humans.store.findOrCreate({
      provider: 'github',
      subject: 'outsider',
      email: null,
    })
    if (outsider.human === undefined) throw new Error('fixture failed to create outsider')
    const session = (await humans.store.openSession(outsider.human.id, {})).session
    expect((await request('GET', '/backend/professions', undefined, session)).statusCode).toBe(404)
    expect(
      (
        await request(
          'POST',
          '/backend/professions/software-producer',
          { expectedVersion: null, definition },
          session,
        )
      ).statusCode,
    ).toBe(404)
    expect(calls).toEqual({ publish: 0, retire: 0, publisherId: null })
  })

  it('rejects path/document mismatch and invalid bodies before storage', async () => {
    expect(
      (
        await request('POST', '/backend/professions/citizen-mentor', {
          expectedVersion: null,
          definition,
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await request('POST', '/backend/professions/software-producer', {
          expectedVersion: null,
          definition: { ...definition, summary: 'password: hunter2' },
        })
      ).statusCode,
    ).toBe(400)
    expect(calls.publish).toBe(0)
  })
})
