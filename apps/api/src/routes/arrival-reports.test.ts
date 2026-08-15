import { API_BASE_PATH, ArrivalReportResponseSchema, ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { anArrivalReport } from '../__fixtures__/arrivals.js'
import { ARRIVAL_REPORT_LIMIT } from '../rate-limit.js'

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

const file = (payload: InjectOptions['payload']) =>
  app.inject({ method: 'POST', url: `${API_BASE_PATH}/arrival-reports`, payload })

/**
 * The REST half of `#1009`.
 *
 * The route matters more than a second door usually would: the caller this is
 * for is one that could not complete an MCP handshake, and an agent that reached
 * for `curl` after the transport defeated it should not find the only channel
 * for saying so behind the transport that defeated it.
 */
describe('POST /v1/arrival-reports (#1009)', () => {
  it('answers 201 with a receipt and nothing else', async () => {
    const response = await file(anArrivalReport())

    expect(response.statusCode).toBe(201)
    const body = ArrivalReportResponseSchema.parse(response.json())
    expect(body.reportId).toMatch(/^[0-9a-f-]{36}$/)
    // The receipt and only the receipt. Nothing here is a thread, and a field
    // that looked like one would be a promise the channel cannot keep.
    expect(Object.keys(response.json())).toEqual(['reportId'])
  })

  /**
   * The whole point, asserted as plainly as it can be: no credential, and no
   * `www-authenticate` on the way back either. A route that answered 401 would
   * be a door reportable only by the callers it had already let through.
   */
  it('takes a report from a caller presenting nothing', async () => {
    const response = await file(anArrivalReport())

    expect(response.statusCode).toBe(201)
    expect(response.headers['www-authenticate']).toBeUndefined()
  })

  it('refuses a report that is missing what a report is made of', async () => {
    const response = await file({ runtime: 'openclaw' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
    expect(Object.keys(response.json().details)).toEqual(
      expect.arrayContaining(['step', 'expected', 'actual']),
    )
  })

  it('refuses a body that is not an object at all', async () => {
    const response = await file('the door did not open')

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
  })

  it('refuses the caller past its allowance with a retry-after', async () => {
    for (let filed = 0; filed < ARRIVAL_REPORT_LIMIT; filed += 1) {
      expect((await file(anArrivalReport())).statusCode).toBe(201)
    }

    const refused = await file(anArrivalReport())

    expect(refused.statusCode).toBe(429)
    // Both spellings, because the two doors answer from one shape: the header
    // is what an HTTP client reads, and the detail is what the tool's error
    // carries to a caller that has no headers.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(refused.json().details.retryAfterSeconds)).toBeGreaterThan(0)
  })

  /**
   * One allowance across both doors (`#236`).
   *
   * The mistake the support desk made once: two surfaces, two limiters, and a
   * caller that alternates gets twice what either says. Here the port is one
   * object handed to both, so the tool's call is charged to the same address the
   * route's was — which is what makes the number in the description true.
   */
  it('shares its allowance with the tool rather than granting a second one', async () => {
    for (let filed = 0; filed < ARRIVAL_REPORT_LIMIT; filed += 1) {
      expect((await file(anArrivalReport())).statusCode).toBe(201)
    }

    const throughTheTool = await colony.arrivals.report({
      // The address the route's caller had: `app.inject` presents a loopback
      // address, and this is the same caller arriving by the other door.
      ip: '127.0.0.1',
      body: anArrivalReport(),
    })

    expect(throughTheTool.outcome).toBe('rate-limited')
  })
})
