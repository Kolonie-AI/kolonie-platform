import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Diagnosis } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeDiagnosesDesk } from '../__fixtures__/doctor.js'
import { fakeHumanStore, fakeTenant } from '../__fixtures__/humans.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'
import { SESSION_COOKIE } from './console.js'

const aDiagnosis = (overrides: Partial<Diagnosis> = {}): Diagnosis => ({
  id: '33333333-3333-4333-8333-333333333333',
  scope: 'colony',
  subject: '/v1/tasks',
  kind: 'retry-storm',
  severity: 'serious',
  confidence: 0.91,
  evidence: { routeKeys: ['/v1/tasks'], figures: { hours: 4, serverErrors: 400 } },
  policyVersion: '2026-08-13.1',
  state: 'open',
  firstSeenAt: '2026-08-13T09:00:00.000Z',
  lastSeenAt: '2026-08-13T13:00:00.000Z',
  observations: 5,
  resolvedAt: null,
  prose: null,
  proseModel: null,
  supportTicketId: null,
  announcedAt: null,
  announcedSeverity: null,
  ...overrides,
})

/**
 * The console's diagnoses pages (`#841`).
 *
 * The test this file exists for is the read-only one, and it is asserted against
 * the **router** rather than against the source: a diagnosis resolves when its
 * evidence stops matching, and a button that closed one would put a person's
 * opinion into a state machine defined by evidence. The two would drift within a
 * month, and the list would stop describing the Colony and start describing what
 * somebody last clicked.
 */
describe('the console’s diagnoses pages', () => {
  /**
   * The console answers on its own host (`#179`), so every request here carries
   * it. Without it the not-found handler answers before the guard is reached,
   * and a test asserting a refusal would be asserting the wrong one.
   */
  const CONSOLE_URL = 'https://console.example'
  const CONSOLE_HOST = 'console.example'

  const withRows = async (rows: readonly Diagnosis[] | undefined) => {
    // Taken out of the fixture rather than overwritten: `fakeColony` wires one
    // by default, and `undefined` here has to mean *this deployment has none*
    // rather than *this deployment has an empty one*.
    const { diagnoses: _wiredByDefault, ...colony } = fakeColony()
    const humans = fakeHumanStore()
    const app = buildApp({
      ...colony,
      console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
      humans: { store: humans, tenant: fakeTenant() },
      ...(rows === undefined ? {} : { diagnoses: fakeDiagnosesDesk(rows) }),
    })
    await app.ready()
    return { app, humans }
  }

  /**
   * A signed-in maintainer.
   *
   * **Every assertion here needs one**, because the guard answers `404` to a
   * reader without the role — deliberately, so a stranger learns nothing about
   * which pages exist. Without a session, *there is no such route* and *you may
   * not read this route* are the same answer, and the read-only assertion below
   * would be true of a section that did not exist.
   */
  const asMaintainer = async (
    app: FastifyInstance,
    humans: ReturnType<typeof fakeHumanStore>,
  ): Promise<Record<string, string>> => {
    const started = await app.inject({
      method: 'GET',
      url: '/sign-in/github',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })
    const state = new URL(started.headers['location'] as string).searchParams.get('state') as string
    const back = await app.inject({
      method: 'GET',
      url: `/sign-in/callback?code=abc&state=${state}`,
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `${OAUTH_STATE_COOKIE}=${state}`,
      },
    })
    const raw = back.headers['set-cookie']
    const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
    const session = all.find((one) => one.startsWith(`${SESSION_COOKIE}=`)) as string

    const people = humans.people()
    humans.maintains(people[people.length - 1]?.id as never)

    return {
      host: CONSOLE_HOST,
      accept: 'text/html',
      cookie: session.slice(0, session.indexOf(';')),
    }
  }

  /**
   * **The rejection case.** Nothing under this section answers to a method that
   * could change anything.
   *
   * **Asserted by asking rather than by reading the router**, which is the
   * stronger form: a `404` means *there is no route here*, where a route that
   * existed and refused would answer `401`. So this is the caller's own
   * experience of the rule, and it covers a route registered from anywhere at
   * all — including a file this test does not import.
   */
  describe('what it is possible to do here', () => {
    const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const
    const paths = ['/backend/diagnoses', '/backend/diagnoses/33333333-3333-4333-8333-333333333333']

    it('serves the section to a maintainer, so the assertion below is not vacuous', async () => {
      const { app, humans } = await withRows([aDiagnosis()])
      const headers = await asMaintainer(app, humans)

      const list = await app.inject({ method: 'GET', url: '/backend/diagnoses', headers })

      expect(list.statusCode).toBe(200)
      expect(list.body).toContain('retry-storm')
    })

    it('answers 404 to every method that could change something', async () => {
      const { app, humans } = await withRows([aDiagnosis()])
      const headers = await asMaintainer(app, humans)

      const answered: string[] = []
      for (const path of paths) {
        for (const method of MUTATING) {
          const response = await app.inject({ method, url: path, headers })
          if (response.statusCode !== 404) {
            answered.push(`${method} ${path} → ${response.statusCode}`)
          }
        }
      }

      expect(answered).toEqual([])
    })
  })

  /**
   * **The second rejection case.** A reader without console access is refused,
   * and the refusal says nothing about whether a diagnosis exists — the same
   * status for a real id and an invented one.
   */
  describe('who may read it', () => {
    it('refuses a request with no session', async () => {
      const { app } = await withRows([aDiagnosis()])

      const headers = { host: CONSOLE_HOST, accept: 'text/html' }
      const list = await app.inject({ method: 'GET', url: '/backend/diagnoses', headers })
      const one = await app.inject({
        method: 'GET',
        url: '/backend/diagnoses/33333333-3333-4333-8333-333333333333',
        headers,
      })
      const invented = await app.inject({
        method: 'GET',
        url: '/backend/diagnoses/44444444-4444-4444-8444-444444444444',
        headers,
      })

      expect(list.statusCode).not.toBe(200)
      // The same answer for an id that names something and one that names
      // nothing: a reader without access learns nothing about which are real.
      expect(one.statusCode).toBe(invented.statusCode)
      expect(one.body).not.toContain('retry-storm')
      expect(one.body).not.toContain('/v1/tasks')
    })
  })

  /**
   * A deployment that wired no desk serves no page rather than an empty one —
   * D-013's way of switching a surface off.
   */
  it('is absent where no desk was wired', async () => {
    const { app, humans } = await withRows(undefined)
    const headers = await asMaintainer(app, humans)

    expect(
      (await app.inject({ method: 'GET', url: '/backend/diagnoses', headers })).statusCode,
    ).toBe(404)
  })

  /**
   * An empty Colony renders a section saying there is nothing open, rather than
   * a blank panel — the `available` lesson from the log seam, applied to a page.
   */
  it('says there is nothing open rather than rendering an empty panel', async () => {
    const { app, humans } = await withRows([])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend/diagnoses', headers })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Nothing is open about the Colony itself')
  })

  describe('one diagnosis, read to the end', () => {
    it('shows the evidence, the rules that produced it and what it caused', async () => {
      const { app, humans } = await withRows([aDiagnosis()])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({
        method: 'GET',
        url: '/backend/diagnoses/33333333-3333-4333-8333-333333333333',
        headers,
      })

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('serverErrors')
      expect(page.body).toContain('2026-08-13.1')
      // What it caused, said in words rather than left blank.
      expect(page.body).toContain('No consequence has been recorded')
    })

    /**
     * A diagnosis with no sentence renders completely. A gateway outage does not
     * produce a broken page (`#840`).
     */
    it('renders completely with no sentence', async () => {
      const { app, humans } = await withRows([aDiagnosis({ prose: null })])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({
        method: 'GET',
        url: '/backend/diagnoses/33333333-3333-4333-8333-333333333333',
        headers,
      })

      expect(page.body).toContain('complete without a sentence')
    })

    /**
     * Resolved and superseded diagnoses are reachable, not deleted from view.
     * **The history is the point** — `kolonie-platform#814` is the complaint
     * about verdicts that cannot be read back.
     */
    it('reaches a resolved one when asked for the history', async () => {
      const { app, humans } = await withRows([
        aDiagnosis({ state: 'resolved', resolvedAt: '2026-08-13T14:00:00.000Z' }),
      ])
      const headers = await asMaintainer(app, humans)

      const current = await app.inject({ method: 'GET', url: '/backend/diagnoses', headers })
      const history = await app.inject({
        method: 'GET',
        url: '/backend/diagnoses?history=1',
        headers,
      })

      expect(current.body).not.toContain('retry-storm')
      expect(history.body).toContain('retry-storm')
    })
  })
})
