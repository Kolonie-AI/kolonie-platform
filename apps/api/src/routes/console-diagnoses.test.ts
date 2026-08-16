import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Diagnosis } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { NOTHING_ANNOUNCED, fakeDiagnosesDesk } from '../__fixtures__/doctor.js'
import type { ConsultationFunnel, RuleHealthRow } from '@kolonie-ai/db'
import { DIAGNOSIS_RETENTION_DAYS } from '@kolonie-ai/core'
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
  // Null until the escalation files an issue for it (`#869`). A colony-scoped
  // finding is the only kind that ever carries one.
  escalatedIssueUrl: null,
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
  consultedAt: null,
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

  const withRows = async (
    rows: readonly Diagnosis[] | undefined,
    /** What the funnel counted, for the tests that are about it (`#1081`). */
    funnel: ConsultationFunnel = NOTHING_ANNOUNCED,
    /** What each rule did, for the tests that are about it (`#1083`). */
    rules: readonly RuleHealthRow[] = [],
  ) => {
    // Taken out of the fixture rather than overwritten: `fakeColony` wires one
    // by default, and `undefined` here has to mean *this deployment has none*
    // rather than *this deployment has an empty one*.
    const { diagnoses: _wiredByDefault, ...colony } = fakeColony()
    const humans = fakeHumanStore()
    const app = buildApp({
      ...colony,
      console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
      humans: { store: humans, tenant: fakeTenant() },
      ...(rows === undefined ? {} : { diagnoses: fakeDiagnosesDesk(rows, funnel, rules) }),
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
    const paths = [
      '/backend/diagnoses',
      '/backend/diagnoses/rules',
      '/backend/diagnoses/33333333-3333-4333-8333-333333333333',
    ]

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

  /**
   * Whether telling citizens anything achieves anything (`#1081`).
   *
   * **The rejection case is the omission.** A Colony that has announced nothing
   * gets no sentence at all rather than one reading *told 0 citizens*: a
   * denominator of zero is not a low uptake, and printing it as one would put a
   * number on the page that a reader would go looking for a cause of.
   */
  describe('whether a told citizen came back', () => {
    it('says how many were told and how many looked', async () => {
      const { app, humans } = await withRows([], {
        announced: 41,
        consulted: 12,
        medianHoursToConsult: 6,
      })
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({ method: 'GET', url: '/backend/diagnoses', headers })

      expect(page.body).toContain('Told 41 citizens in the last 30 days')
      expect(page.body).toContain('12 consulted the Doctor afterwards, typically within 6 hours')
    })

    /** Told and ignored is a finding, and it is the one worth reading plainly. */
    it('says so plainly when nobody came back', async () => {
      const { app, humans } = await withRows([], {
        announced: 7,
        consulted: 0,
        medianHoursToConsult: null,
      })
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({ method: 'GET', url: '/backend/diagnoses', headers })

      expect(page.body).toContain('none has consulted the Doctor afterwards')
    })

    it('leaves the sentence out entirely when nobody was told', async () => {
      const { app, humans } = await withRows([])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({ method: 'GET', url: '/backend/diagnoses', headers })

      expect(page.body).not.toContain('consulted the Doctor')
      expect(page.body).not.toContain('Told 0 citizens')
    })
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

  /**
   * Which rules are any good (`#1083`).
   *
   * **The path is a word where the route beside it takes a uuid**, and the two
   * are registered in an order this block pins down. `rules` would fail the
   * detail handler's id check today, so the shadowing test is not asserting
   * anything about the id format — it is asserting that both paths answer, so
   * that a later id shape admitting a word cannot silently swallow this page
   * without a test going red.
   */
  describe('which rules are any good', () => {
    const aRule = (overrides: Partial<RuleHealthRow> = {}): RuleHealthRow => ({
      kind: 'polling-loop',
      policyVersion: '2026-08-13.1',
      opened: 5,
      announced: 4,
      consulted: 2,
      resolvedAfterAnnouncement: 1,
      medianHoursToConsult: 3,
      helpful: 2,
      notApplicable: 0,
      wrong: 1,
      ...overrides,
    })

    it('shows a maintainer what each rule did and what was said about it', async () => {
      const { app, humans } = await withRows([], NOTHING_ANNOUNCED, [aRule()])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({ method: 'GET', url: '/backend/diagnoses/rules', headers })

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('polling-loop')
      expect(page.body).toContain('2026-08-13.1')
      // The whole row, in order, so that a column swapped with its neighbour is
      // a failure rather than nine numbers that all still appear somewhere.
      expect(page.body).toContain(
        '<td>5</td><td>4</td><td>2</td><td>1</td><td>3</td><td>2</td><td>0</td><td>1</td>',
      )
    })

    /**
     * **The rejection case.** A reader without the maintainer role is refused
     * and the refusal carries none of the figures — not the counts, not the
     * rule names, not the policy version. A page that leaked its own table into
     * a 404 body would pass a status assertion and fail the point of the guard.
     */
    it('refuses a reader with no session and shows none of the figures', async () => {
      const { app } = await withRows([], NOTHING_ANNOUNCED, [aRule()])

      const page = await app.inject({
        method: 'GET',
        url: '/backend/diagnoses/rules',
        headers: { host: CONSOLE_HOST, accept: 'text/html' },
      })

      expect(page.statusCode).not.toBe(200)
      expect(page.body).not.toContain('polling-loop')
      expect(page.body).not.toContain('2026-08-13.1')
      expect(page.body).not.toContain('Median hours to consult')
    })

    /**
     * **Adding this page did not shadow the diagnosis beside it.** Both routes
     * are asked in one test, so a registration order that broke the detail page
     * cannot pass by the rules page alone being green.
     */
    it('leaves the detail route answering, and an unknown id still 404s', async () => {
      const { app, humans } = await withRows([aDiagnosis()], NOTHING_ANNOUNCED, [aRule()])
      const headers = await asMaintainer(app, humans)

      const rules = await app.inject({ method: 'GET', url: '/backend/diagnoses/rules', headers })
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

      expect(rules.statusCode).toBe(200)
      expect(one.statusCode).toBe(200)
      expect(one.body).toContain('serverErrors')
      // Never 403: a maintainer asking for an id that names nothing is being
      // told there is nothing, not that they may not read it.
      expect(invented.statusCode).toBe(404)
    })

    /**
     * The retention line is read from the constant rather than from the number
     * it currently holds, so that changing {@link DIAGNOSIS_RETENTION_DAYS}
     * changes the page and a test written against `90` cannot go on passing
     * once it has.
     */
    it('names the retention window from the constant', async () => {
      const { app, humans } = await withRows([], NOTHING_ANNOUNCED, [aRule()])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({ method: 'GET', url: '/backend/diagnoses/rules', headers })

      expect(page.body).toContain(`Diagnoses are kept ${DIAGNOSIS_RETENTION_DAYS} days`)
    })

    /**
     * **No percentage anywhere.** `Resolved after` is a count of findings that
     * resolved once their citizen had been told, and a ratio built from it would
     * be read as *the rule worked this often* — which is not what anything here
     * measures, because a diagnosis resolves when its evidence stops matching
     * and the citizen may have stopped for reasons of its own.
     */
    it('puts no success rate on the page', async () => {
      const { app, humans } = await withRows([], NOTHING_ANNOUNCED, [aRule()])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({ method: 'GET', url: '/backend/diagnoses/rules', headers })

      // The section rather than the document: the console's stylesheet is full
      // of percentages and none of them is a figure about a rule.
      const main = page.body.slice(page.body.indexOf('<main'), page.body.indexOf('</main>'))

      expect(main).toContain('polling-loop')
      expect(main).not.toContain('%')
      expect(main).toContain('does not establish that being told is why')
    })

    /**
     * Nobody consulted is a dash and never a nought, because a zero in that
     * column reads as *they all came back instantly* — the opposite of what
     * happened.
     */
    it('leaves the median blank when nobody consulted', async () => {
      const { app, humans } = await withRows([], NOTHING_ANNOUNCED, [
        aRule({ consulted: 0, medianHoursToConsult: null }),
      ])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({ method: 'GET', url: '/backend/diagnoses/rules', headers })

      expect(page.body).toContain('<td>—</td>')
    })

    /**
     * A verdict whose citizen had nothing open carries no policy version, so the
     * row has none either. Said in words rather than rendered as a blank cell,
     * which would read as a rendering fault.
     */
    it('says so in words when a row has no rules on file', async () => {
      const { app, humans } = await withRows([], NOTHING_ANNOUNCED, [
        aRule({ policyVersion: null, opened: 0, announced: 0, consulted: 0 }),
      ])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({ method: 'GET', url: '/backend/diagnoses/rules', headers })

      expect(page.body).toContain('no rules on file')
    })

    it('says there is nothing rather than rendering an empty table', async () => {
      const { app, humans } = await withRows([])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({ method: 'GET', url: '/backend/diagnoses/rules', headers })

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('No rule has produced a finding')
    })

    /** The page is reached from the list, or it is reached by nobody. */
    it('is linked from the diagnoses page', async () => {
      const { app, humans } = await withRows([])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({ method: 'GET', url: '/backend/diagnoses', headers })

      expect(page.body).toContain('/backend/diagnoses/rules')
    })

    /**
     * The JSON branch answers the same rows the HTML branch rendered — one read
     * behind two representations, rather than two paths that could drift.
     */
    it('answers the same rows as JSON', async () => {
      const { app, humans } = await withRows([], NOTHING_ANNOUNCED, [aRule()])
      const headers = await asMaintainer(app, humans)

      const page = await app.inject({
        method: 'GET',
        url: '/backend/diagnoses/rules',
        headers: { ...headers, accept: 'application/json' },
      })

      expect(page.statusCode).toBe(200)
      expect(page.json()).toEqual({ rules: [aRule()] })
    })
  })
})
