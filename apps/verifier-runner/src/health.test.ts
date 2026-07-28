import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { TaskTypeSchema } from '@kolonie-ai/core'
import { createHealthServer, healthOf, HEALTH_PATH } from './health.js'
import type { RunnerHealth } from './loop.js'

const EXAMPLE_TASK = TaskTypeSchema.parse('example-task')
const STALE_AFTER_MS = 15_000
const AT = Date.parse('2026-07-28T12:00:00.000Z')

const health = (overrides: Partial<RunnerHealth> = {}): RunnerHealth => ({
  running: true,
  lastPollAt: '2026-07-28T11:59:55.000Z',
  consecutiveFailures: 0,
  inFlight: 0,
  taskTypes: [EXAMPLE_TASK],
  ...overrides,
})

describe('healthOf', () => {
  it('is ok while polls keep completing', () => {
    expect(healthOf(health(), STALE_AFTER_MS, AT).status).toBe('ok')
  })

  it('is stalled when the loop has been silent for too long', () => {
    const report = healthOf(health({ lastPollAt: '2026-07-28T11:59:00.000Z' }), STALE_AFTER_MS, AT)
    expect(report.status).toBe('stalled')
    expect(report.reason).toContain('60s ago')
  })

  it('is stalled before the first poll completes', () => {
    expect(healthOf(health({ lastPollAt: null }), STALE_AFTER_MS, AT).status).toBe('stalled')
  })

  it('is stalled once the loop has been stopped', () => {
    expect(healthOf(health({ running: false }), STALE_AFTER_MS, AT).status).toBe('stalled')
  })

  /**
   * A runner waiting out a database restart is doing its job, and reporting it
   * unhealthy would have the orchestrator restart the one process that was
   * handling the outage correctly. Silence is the symptom, not failure.
   */
  it('stays ok while backing off, as long as the loop is still turning', () => {
    const report = healthOf(health({ consecutiveFailures: 4 }), STALE_AFTER_MS, AT)
    expect(report.status).toBe('ok')
    expect(report.consecutiveFailures).toBe(4)
  })
})

describe('the health server', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  })

  /** Port 0 lets the OS pick a free one; it is only known once bound. */
  const start = async (report: () => RunnerHealth): Promise<string> => {
    const started = createHealthServer({ port: 0, staleAfterMs: STALE_AFTER_MS, health: report })
    server = started
    if (!started.listening) {
      await new Promise<void>((resolve) => started.once('listening', () => resolve()))
    }
    return `http://127.0.0.1:${(started.address() as AddressInfo).port}`
  }

  it('answers 200 while the loop is turning', async () => {
    const base = await start(() => health({ lastPollAt: new Date().toISOString() }))

    const response = await fetch(`${base}${HEALTH_PATH}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', verifiers: ['example-task'] })
  })

  /**
   * The whole point of this endpoint. The Compose healthcheck for this container
   * used to be `node -e "process.exit(0)"`, which reports a process wrapped
   * around a dead loop as healthy — see kolonie-infra#11.
   */
  it('answers 503 when the loop has stopped, though the process is up', async () => {
    const base = await start(() => health({ running: false }))

    const response = await fetch(`${base}${HEALTH_PATH}`)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'stalled' })
  })

  it('serves nothing else', async () => {
    const base = await start(() => health({ lastPollAt: new Date().toISOString() }))

    const response = await fetch(`${base}/v1/tasks`)

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ paths: [HEALTH_PATH] })
  })
})
