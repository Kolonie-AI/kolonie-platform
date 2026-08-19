import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { DeskTicketDetail } from '@kolonie-ai/db'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeTicketDesk } from '../__fixtures__/ticket-desk.js'
import { fakeHumanStore, fakeTenant } from '../__fixtures__/humans.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'
import { SESSION_COOKIE } from './console.js'

const TICKET = '66666666-6666-4666-8666-666666666666'
const AGENT = '44444444-4444-4444-8444-444444444444'

const aTicket = (overrides: Partial<DeskTicketDetail> = {}): DeskTicketDetail => ({
  id: TICKET as never,
  subject: 'My suspension was a mistake',
  kind: 'objection',
  status: 'open',
  agentId: AGENT as never,
  agentName: 'a-walker',
  agentStatus: 'suspended',
  openedAt: '2026-08-13T09:00:00.000Z' as never,
  answered: false,
  body: 'Nine of my refused walks were the same false positive.',
  resolution: null,
  issueUrl: null,
  aboutSubmissionId: null,
  aboutProvider: null,
  updatedAt: '2026-08-13T09:00:00.000Z' as never,
  ...overrides,
})

/**
 * The console's tickets-to-answer desk (`#1347`).
 *
 * What is asserted here is the **shape of the surface**. Which tickets are on
 * the desk at all is `route = 'desk'` in SQL and is asserted against a real
 * database in `packages/db`; what a route test can say is that the page draws
 * the queue, that each of the four buttons reaches the desk with the words the
 * form carried, and that a settling answer with nothing written is refused
 * where a person can still put it right.
 */
describe('the console’s tickets-to-answer desk', () => {
  /** The console answers on its own host (`#179`), so every request carries it. */
  const CONSOLE_URL = 'https://console.example'
  const CONSOLE_HOST = 'console.example'

  const withTickets = async (tickets: readonly DeskTicketDetail[] | undefined) => {
    // Taken out of the fixture rather than overwritten, exactly as the refusals
    // test does it: `undefined` here has to mean *this deployment wired none*
    // rather than *this deployment wired an empty one*.
    const { ticketDesk: _wiredByDefault, ...colony } = fakeColony()
    const humans = fakeHumanStore()
    const desk = tickets === undefined ? undefined : fakeTicketDesk(tickets)
    const app = buildApp({
      ...colony,
      console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
      humans: { store: humans, tenant: fakeTenant() },
      ...(desk === undefined ? {} : { ticketDesk: desk }),
    })
    await app.ready()
    return { app, humans, desk }
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

  it('names who is waiting and what they wrote in about', async () => {
    const { app, humans } = await withTickets([aTicket()])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend/desk', headers })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('My suspension was a mistake')
    expect(page.body).toContain('a-walker')
  })

  /**
   * **Standing on the queue, not only on the ticket.** A desk ticket from a
   * suspended citizen is usually an appeal, and a maintainer deciding what to
   * read first is deciding on exactly that.
   */
  it('says how the citizen stands', async () => {
    const { app, humans } = await withTickets([aTicket()])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend/desk', headers })

    expect(page.body).toContain('suspended')
  })

  it('says so when nothing is waiting, rather than drawing an empty table', async () => {
    const { app, humans } = await withTickets([])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend/desk', headers })

    expect(page.statusCode).toBe(200)
    expect(page.body).not.toContain('<table>')
  })

  it('carries what the citizen wrote on the ticket itself', async () => {
    const { app, humans } = await withTickets([aTicket()])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: `/backend/desk/${TICKET}`, headers })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Nine of my refused walks were the same false positive.')
  })

  it('answers 404 for a ticket that is not on this desk', async () => {
    const { app, humans } = await withTickets([])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: `/backend/desk/${TICKET}`, headers })

    expect(page.statusCode).toBe(404)
  })

  /**
   * D-013: a deployment that wired no desk serves no page. `404` rather than an
   * empty one, so a reader is never shown a queue that means nothing.
   */
  it('is not there at all where no desk was wired', async () => {
    const { app, humans } = await withTickets(undefined)
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend/desk', headers })

    expect(page.statusCode).toBe(404)
  })

  it('refuses a reader with no session', async () => {
    const { app } = await withTickets([aTicket()])

    const page = await app.inject({
      method: 'GET',
      url: '/backend/desk',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(page.statusCode).not.toBe(200)
  })

  /**
   * **The count on `/backend`, and why it is there.** A queue nobody is reminded
   * of is a queue that grows: the index is the page a maintainer opens, and it
   * is the only place the desk's depth can reach somebody who was not looking
   * for it.
   */
  it('counts what is waiting on the index', async () => {
    const { app, humans } = await withTickets([aTicket()])
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend', headers })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('/backend/desk')
    expect(page.body).toContain('One ticket is waiting')
  })

  /**
   * The navigation names the page either way — that table is static, and a link
   * to a route this deployment answers `404` for is what `/backend/refusals`
   * already does. What must not appear is the *count*, which would be a claim
   * about a queue there is none of.
   */
  it('counts nothing on the index where no desk was wired', async () => {
    const { app, humans } = await withTickets(undefined)
    const headers = await asMaintainer(app, humans)

    const page = await app.inject({ method: 'GET', url: '/backend', headers })

    expect(page.statusCode).toBe(200)
    expect(page.body).not.toContain('waiting for a person to answer')
  })

  describe('the four things a person may do', () => {
    it('answers and settles, with the words the form carried', async () => {
      const { app, humans, desk } = await withTickets([aTicket()])
      const headers = await asMaintainer(app, humans)

      const answered = await app.inject({
        method: 'POST',
        url: `/backend/desk/${TICKET}/answer`,
        headers,
        payload: { status: 'resolved', resolution: 'Lifted, and the rule was narrowed.' },
      })

      expect(answered.statusCode).toBe(200)
      expect(desk?.answers).toEqual([
        {
          ticketId: TICKET,
          status: 'resolved',
          resolution: 'Lifted, and the rule was narrowed.',
        },
      ])
      expect(answered.body).toContain('Answered, and resolved')
    })

    /**
     * **An acknowledgement is a promise to answer, so it stays in the count.**
     * The notice says as much, because a maintainer pressing it is otherwise
     * entitled to read it as *dealt with*.
     */
    it('acknowledges without settling', async () => {
      const { app, humans } = await withTickets([aTicket()])
      const headers = await asMaintainer(app, humans)

      const answered = await app.inject({
        method: 'POST',
        url: `/backend/desk/${TICKET}/answer`,
        headers,
        payload: { status: 'acknowledged' },
      })

      expect(answered.statusCode).toBe(200)
      expect(answered.body).toContain('It stays on the desk and in the count')
    })

    /**
     * **The one refusal this page makes.** A citizen told their ticket is closed
     * and not told why has been answered with silence — and because that is a
     * thing a person puts right by typing a sentence, it is a notice on the page
     * they are already looking at rather than a 500 that loses their draft.
     */
    it('refuses to settle a ticket with nothing written', async () => {
      const { app, humans } = await withTickets([aTicket()])
      const headers = await asMaintainer(app, humans)

      const answered = await app.inject({
        method: 'POST',
        url: `/backend/desk/${TICKET}/answer`,
        headers,
        payload: { status: 'declined' },
      })

      expect(answered.statusCode).toBe(200)
      expect(answered.body).toContain('has to say why')
    })

    it('refuses a status the form has no button for', async () => {
      const { app, humans } = await withTickets([aTicket()])
      const headers = await asMaintainer(app, humans)

      const answered = await app.inject({
        method: 'POST',
        url: `/backend/desk/${TICKET}/answer`,
        headers,
        payload: { status: 'open' },
      })

      expect(answered.statusCode).toBe(400)
    })

    /** `#1343`: the only route back to the queue that files public issues. */
    it('promotes a ticket to the colony queue', async () => {
      const { app, humans, desk } = await withTickets([aTicket()])
      const headers = await asMaintainer(app, humans)

      const promoted = await app.inject({
        method: 'POST',
        url: `/backend/desk/${TICKET}/promote`,
        headers,
        payload: {},
      })

      expect(promoted.statusCode).toBe(200)
      expect(desk?.promotions).toEqual([TICKET])
      expect(promoted.body).toContain('Back in front of triage')
    })

    it('says nothing happened where the ticket is not on this desk', async () => {
      const { app, humans } = await withTickets([])
      const headers = await asMaintainer(app, humans)

      const promoted = await app.inject({
        method: 'POST',
        url: `/backend/desk/${TICKET}/promote`,
        headers,
        payload: {},
      })

      expect(promoted.statusCode).toBe(200)
      expect(promoted.body).toContain('Nothing to promote')
    })

    it('refuses a write from a reader with no session', async () => {
      const { app, desk } = await withTickets([aTicket()])

      const answered = await app.inject({
        method: 'POST',
        url: `/backend/desk/${TICKET}/answer`,
        headers: { host: CONSOLE_HOST, accept: 'text/html' },
        payload: { status: 'resolved', resolution: 'Not from out here.' },
      })

      expect(answered.statusCode).not.toBe(200)
      expect(desk?.answers).toEqual([])
    })

    /**
     * There is no route that could reopen a ticket by hand, and this is where
     * that is held: a ticket leaves this desk by being promoted, which is a
     * decision with a queue behind it, or it does not leave.
     */
    it('has no way to reopen a ticket', async () => {
      const { app, humans } = await withTickets([aTicket()])
      const headers = await asMaintainer(app, humans)

      const answered: string[] = []
      for (const path of [`/backend/desk/${TICKET}/reopen`, '/backend/desk']) {
        const response = await app.inject({ method: 'POST', url: path, headers, payload: {} })
        if (response.statusCode !== 404)
          answered.push(`POST ${path} → ${String(response.statusCode)}`)
      }

      expect(answered).toEqual([])
    })
  })
})
