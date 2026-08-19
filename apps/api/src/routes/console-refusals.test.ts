import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { WalkRefusalTally } from '@kolonie-ai/db'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeWalkRefusalDesk } from '../__fixtures__/walk-refusals.js'
import { fakeHumanStore, fakeTenant } from '../__fixtures__/humans.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'
import { SESSION_COOKIE } from './console.js'

const AGENT = '44444444-4444-4444-8444-444444444444'

const aTally = (overrides: Partial<WalkRefusalTally> = {}): WalkRefusalTally => ({
  agentId: AGENT,
  name: 'a-walker',
  status: 'suspended',
  refusals: 5,
  decidedInWindow: 12,
  refusedInWindow: 7,
  walks: [
    {
      walkId: '55555555-5555-4555-8555-555555555555',
      kind: 'mailbox',
      provider: 'provider-one.example',
      finishedAt: '2026-08-13T09:00:00.000Z',
      reason: 'It names the person the walker was emailing.',
    },
  ],
  ...overrides,
})

/**
 * The console's refusals page (`#1097`).
 *
 * What is asserted here is the **shape of the surface**, because that is where
 * this issue's decisions live. The counting and the threshold are SQL and are
 * asserted against a real database in `packages/db`; what a route test can say
 * is that the page shows the refusals and not the prose, and that the only thing
 * a person may press takes a suspension *off*.
 */
describe('the console’s refusals page', () => {
  /** The console answers on its own host (`#179`), so every request carries it. */
  const CONSOLE_URL = 'https://console.example'
  const CONSOLE_HOST = 'console.example'

  const withTallies = async (tallies: readonly WalkRefusalTally[] | undefined, lifts = true) => {
    // Taken out of the fixture rather than overwritten, exactly as the diagnoses
    // test does it: `undefined` here has to mean *this deployment wired none*
    // rather than *this deployment wired an empty one*.
    const { walkRefusals: _wiredByDefault, ...colony } = fakeColony()
    const humans = fakeHumanStore()
    const app = buildApp({
      ...colony,
      console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
      humans: { store: humans, tenant: fakeTenant() },
      ...(tallies === undefined ? {} : { walkRefusals: fakeWalkRefusalDesk(tallies, lifts) }),
    })
    await app.ready()
    return { app, humans }
  }

  /**
   * A signed-in maintainer. Every assertion needs one: the guard answers `404`
   * to a reader without the role, so without a session *there is no such route*
   * and *you may not read it* are the same answer.
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

  it('names the walkers and what was refused of them', async () => {
    const { app, humans } = await withTallies([aTally()])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend/refusals', headers })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('a-walker')
    expect(page.body).toContain('provider-one.example')
  })

  /**
   * **The decision this page is built around.** A refused walk has no scrub, so
   * the only text on it is what a red line was drawn against — and a maintainer's
   * list is not where that gets read back. The tally carries no prose at all, and
   * this is the assertion that keeps a future column from adding one.
   */
  it('carries the refusals and never the prose', async () => {
    const { app, humans } = await withTallies([aTally()])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({
      method: 'GET',
      url: '/backend/refusals',
      headers: { ...headers, accept: 'application/json' },
    })

    // Asserted against what the surface hands over rather than against the
    // markup: the words *prose* and *refused* are in the page's own note, so a
    // string search there would pass on a page that showed the text as well.
    const [walk] = (page.json() as { tallies: readonly WalkRefusalTally[] }).tallies[0]?.walks ?? []
    expect(Object.keys(walk ?? {})).toEqual([
      'walkId',
      'kind',
      'provider',
      'finishedAt',
      // The moderator's own sentence about the walk (`#1340`), which is not the
      // walk's words and is the one thing here that may say why.
      'reason',
    ])
  })

  /**
   * **Why it was refused, on the page** (`#1340`). A maintainer looking at a
   * suspension is deciding whether to lift it, and a list of providers with no
   * verdict beside them makes that decision on nothing. The sentence is the
   * Colony's own — it is safe here in a way the citizen's words are not, and it
   * goes through the same escape as every other cell.
   */
  it('shows the moderator’s reason beside each refused walk', async () => {
    const { app, humans } = await withTallies([aTally()])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend/refusals', headers })

    expect(page.body).toContain('It names the person the walker was emailing.')
  })

  /** A walk refused before `#1340` carries no sentence, and the row still draws. */
  it('draws a walk that has no reason', async () => {
    const { app, humans } = await withTallies([
      aTally({
        walks: [
          {
            walkId: '55555555-5555-4555-8555-555555555555',
            kind: 'mailbox',
            provider: 'provider-two.example',
            finishedAt: '2026-08-13T09:00:00.000Z',
            reason: null,
          },
        ],
      }),
    ])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend/refusals', headers })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('provider-two.example')
  })

  it('says so when nothing has been refused, rather than drawing an empty table', async () => {
    const { app, humans } = await withTallies([])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend/refusals', headers })

    expect(page.statusCode).toBe(200)
    expect(page.body).not.toContain('<table>')
  })

  /**
   * D-013: a deployment that wired no desk serves no page. `404` rather than an
   * empty one, so a reader is never shown a table that means nothing.
   */
  it('is not there at all where no desk was wired', async () => {
    const { app, humans } = await withTallies(undefined)
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend/refusals', headers })

    expect(page.statusCode).toBe(404)
  })

  it('refuses a reader with no session', async () => {
    const { app } = await withTallies([aTally()])

    const page = await app.inject({
      method: 'GET',
      url: '/backend/refusals',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(page.statusCode).not.toBe(200)
  })

  /**
   * **The only button, and it lifts.** The threshold imposes a suspension inside
   * the verdict that reaches it, so a *suspend* here would be a second answer to
   * a question the count already answers — and one a person could give without
   * anything having been refused at all.
   */
  describe('the one thing a person may do', () => {
    it('lifts a suspension and says what came back', async () => {
      const { app, humans } = await withTallies([aTally()])
      const headers = await asMaintainer(app, humans)

      const lifted = await app.inject({
        method: 'POST',
        url: '/backend/refusals/lift',
        headers,
        payload: { agentId: AGENT },
      })

      expect(lifted.statusCode).toBe(200)
      expect(lifted.body).toContain('Suspension lifted')
    })

    /**
     * The store decides, and the page reports. A walker that was not suspended —
     * or one that is banned, which a lift never touches — gets the other notice
     * rather than a claim that something happened.
     */
    it('says nothing happened where the store lifted nothing', async () => {
      const { app, humans } = await withTallies([aTally()], false)
      const headers = await asMaintainer(app, humans)

      const lifted = await app.inject({
        method: 'POST',
        url: '/backend/refusals/lift',
        headers,
        payload: { agentId: AGENT },
      })

      expect(lifted.statusCode).toBe(200)
      expect(lifted.body).toContain('Nothing to lift')
    })

    it('refuses a lift from a reader with no session', async () => {
      const { app } = await withTallies([aTally()])

      const lifted = await app.inject({
        method: 'POST',
        url: '/backend/refusals/lift',
        headers: { host: CONSOLE_HOST, accept: 'text/html' },
        payload: { agentId: AGENT },
      })

      expect(lifted.statusCode).not.toBe(200)
    })

    /** There is no route that could impose one, and this is where that is held. */
    it('has no way to suspend anybody', async () => {
      const { app, humans } = await withTallies([aTally()])
      const headers = await asMaintainer(app, humans)

      const answered: string[] = []
      for (const path of ['/backend/refusals/suspend', '/backend/refusals']) {
        const response = await app.inject({ method: 'POST', url: path, headers, payload: {} })
        if (response.statusCode !== 404)
          answered.push(`POST ${path} → ${String(response.statusCode)}`)
      }

      expect(answered).toEqual([])
    })
  })
})
