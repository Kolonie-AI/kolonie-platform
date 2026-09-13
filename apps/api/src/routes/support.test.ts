import { randomUUID } from 'node:crypto'
import {
  API_BASE_PATH,
  ListTicketsResponseSchema,
  SUPPORT_TICKETS_DEFAULT_PAGE,
} from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { FAKE_CALLER_IP, fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'

describe('GET /v1/support/tickets', () => {
  let app: FastifyInstance
  let colony: FakeColony
  let authorization: string

  beforeEach(async () => {
    colony = fakeColony()
    app = buildApp(colony)
    await app.ready()
    const registered = await colony.registry.register(
      {
        name: `ticket-writer-${randomUUID().slice(0, 8)}`,
        platform: 'openclaw',
      },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') {
      throw new Error(`fixture failed to register: ${registered.outcome}`)
    }
    authorization = `Bearer ${registered.response.credentials.apiKey}`
  })

  afterEach(async () => {
    await app.close()
  })

  const open = (index: number) =>
    app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/support/tickets`,
      headers: { authorization },
      payload: {
        kind: 'defect',
        subject: `Support page ${String(index).padStart(2, '0')}`,
        body: 'A complete description of what failed and what the caller expected instead.',
      },
    })

  it('traverses bounded pages through the REST query arguments', async () => {
    const total = SUPPORT_TICKETS_DEFAULT_PAGE + 2
    for (let index = 0; index < total; index += 1) expect((await open(index)).statusCode).toBe(201)

    const firstResponse = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/support/tickets`,
      headers: { authorization },
    })
    expect(firstResponse.statusCode).toBe(200)
    const first = ListTicketsResponseSchema.parse(firstResponse.json())
    expect(first.tickets).toHaveLength(SUPPORT_TICKETS_DEFAULT_PAGE)
    expect(first.nextCursor).toBeDefined()

    const secondResponse = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/support/tickets?cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { authorization },
    })
    const second = ListTicketsResponseSchema.parse(secondResponse.json())
    expect(second.tickets).toHaveLength(2)
    expect(second).not.toHaveProperty('nextCursor')
    expect(new Set([...first.tickets, ...second.tickets].map((ticket) => ticket.id))).toHaveLength(
      total,
    )
  })

  it('refuses an invalid cursor and an invalid page size', async () => {
    const invalidCursor = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/support/tickets?cursor=not-a-cursor`,
      headers: { authorization },
    })
    const invalidLimit = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/support/tickets?limit=17`,
      headers: { authorization },
    })

    expect(invalidCursor.statusCode).toBe(422)
    expect(invalidCursor.json()).toMatchObject({ code: 'validation_failed' })
    expect(invalidLimit.statusCode).toBe(422)
    expect(invalidLimit.json()).toMatchObject({ code: 'validation_failed' })
  })
})
