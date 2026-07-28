import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { fakeRegistry } from './__fixtures__/registry.js'
import { fakeStore } from './__fixtures__/store.js'

let app: FastifyInstance

beforeAll(async () => {
  app = buildApp({ registry: fakeRegistry(), store: fakeStore() })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('GET /health', () => {
  it('answers 200 so the container healthcheck passes', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('is deliberately unversioned — Docker must not track API versions', async () => {
    const versioned = await app.inject({ method: 'GET', url: '/v1/health' })
    expect(versioned.statusCode).toBe(404)
  })
})

describe('versioning', () => {
  it('serves the index under /v1', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1' })
    expect(response.statusCode).toBe(200)
    expect(response.json().version).toBe('v1')
  })

  it('does not answer unversioned agent routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/agents/me' })
    expect(response.statusCode).toBe(404)
  })
})

describe('errors', () => {
  it('returns a machine-readable code an agent can branch on', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' })
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('not_found')
  })

  it('tells a lost caller where the endpoints live', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' })
    expect(response.json().message).toContain('/v1')
  })
})
