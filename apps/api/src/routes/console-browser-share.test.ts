import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeShares } from '../__fixtures__/browser-shares.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * The operator's window onto a shared tab (`#738`).
 *
 * **What is asserted here is the door and the header, not the picture.** Whether
 * a frame arrives is `#736`'s relay and is tested there; whether the row appears
 * in the queue is the queue's; whether a stranger is refused is the join in
 * `shareOfferedTo`, which is storage and is tested against a real database. What
 * only this layer can answer is that the page is behind a session, that the four
 * wrong ids are indistinguishable, and that the one page in the console carrying
 * script says so in its own header — the last being the reason the exception was
 * acceptable at all.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let shares: ReturnType<typeof fakeShares>
let agentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  shares = fakeShares()
  const agents = fakeStore()
  const pages = fakeOperatorPages()

  app = buildApp({
    ...fakeColony(),
    shares,
    store: agents,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
    autonomy: {
      store: fakeAutonomyStore(),
      pages,
      mailer: fakeAutonomyMailer(),
      formBaseUrl: CONSOLE_URL,
    },
  })
  await app.ready()

  agentId = agents.issue().agent.id
  shares.allow(agentId)
})

afterEach(async () => {
  await app?.close()
})

const signedInCookie = async (): Promise<string> => {
  const started = await app.inject({
    method: 'GET',
    url: '/sign-in/github',
    headers: { host: CONSOLE_HOST, accept: 'text/html' },
  })
  const state = new URL(started.headers['location'] as string).searchParams.get('state') as string
  const back = await app.inject({
    method: 'GET',
    url: `/sign-in/callback?code=abc&state=${state}`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  })
  const raw = back.headers['set-cookie']
  const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  const cookie = all.find((one) => one.startsWith(`${SESSION_COOKIE}=`)) as string
  return cookie.slice(0, cookie.indexOf(';'))
}

/** An offer of a live tab, as the agent's own tool would have made it. */
const anOffer = async (): Promise<string> => {
  const offered = await shares.offer({
    agentId,
    targetId: 'page-1',
    purpose: 'The signup page wants a picture puzzle solved.',
    provider: 'mail.tm',
    step: 3,
  })
  if (offered.outcome !== 'offered') throw new Error(`the offer was refused: ${offered.reason}`)
  return offered.share.id
}

const open = (shareId: string, cookie?: string) =>
  app.inject({
    method: 'GET',
    url: `/browser/share/${shareId}`,
    headers: {
      host: CONSOLE_HOST,
      accept: 'text/html,application/xhtml+xml',
      ...(cookie === undefined ? {} : { cookie }),
    },
  })

describe('the operator’s window onto a shared tab', () => {
  it('says whose tab it is, what closes it, and what the agent asked for', async () => {
    const cookie = await signedInCookie()
    const shareId = await anOffer()

    const page = await open(shareId, cookie)

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('own tab')
    expect(page.body).toContain('the agent carries on with it afterwards')
    expect(page.body).toContain('The signup page wants a picture puzzle solved.')
    expect(page.body).toContain('mail.tm, step 3')
  })

  /**
   * The refusal the issue writes down as the boundary: *"if the window ever
   * grows an address bar, the scope has grown with it."* An operator clicks and
   * types on the page the agent chose, and there is nowhere in the document to
   * name another one — no field, no form, and none of the console's own
   * navigation either, which is why this page is not routed through `page()`.
   */
  it('carries no navigation surface of any kind', async () => {
    const cookie = await signedInCookie()
    const page = await open(await anOffer(), cookie)

    expect(page.body).not.toContain('<form')
    expect(page.body).not.toContain('type="url"')
    expect(page.body).not.toContain('href="/agents')
    // One control, and it ends the session rather than driving anything.
    expect(page.body).toContain('id="done"')
  })

  /**
   * A black rectangle is a claim about a session (`#805`). The picture arrives
   * with the first frame or the page says why there is none — what it must not
   * do is render an empty viewer that reads as one still loading.
   */
  it('shows no viewer until a frame has arrived', async () => {
    const cookie = await signedInCookie()
    const page = await open(await anOffer(), cookie)

    expect(page.body).toContain('id="view" hidden')
    expect(page.body).toContain('.share-view[hidden]{display:none}')
  })

  /**
   * The one documented exception to a scriptless console, and it is pinned
   * rather than opened: a hash and not `'unsafe-inline'`, so the page permits
   * the viewer and nothing an injection managed to place beside it.
   */
  it('pins its own script by hash and permits the socket and the frames', async () => {
    const cookie = await signedInCookie()
    const page = await open(await anOffer(), cookie)
    const csp = String(page.headers['content-security-policy'])

    expect(csp).toContain("script-src 'sha256-")
    expect(csp).not.toContain("script-src 'unsafe-inline'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("img-src 'self' data:")
    // A live browser session inside somebody else's frame is exactly the shape
    // a clickjack would want, and this is inherited rather than restated.
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('leaves every other console page scriptless', async () => {
    const cookie = await signedInCookie()
    const dashboard = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(String(dashboard.headers['content-security-policy'])).not.toContain('script-src')
    expect(dashboard.body).not.toContain('<script')
  })

  it('is a page for a signed-in person and not for anybody with the id', async () => {
    const shareId = await anOffer()

    const anonymous = await open(shareId)

    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.body).toContain('Sign in')
    expect(anonymous.body).not.toContain('own tab')
  })

  /**
   * A guessed id and a closed one answer the same, deliberately: an id that said
   * *this exists but is not yours* would be a way to learn that an agent has an
   * operator and is stuck right now.
   */
  it('tells a guessed id and a closed one the same thing', async () => {
    const cookie = await signedInCookie()
    const shareId = await anOffer()

    const guessed = await open(randomUUID(), cookie)
    expect(guessed.statusCode).toBe(404)

    await shares.close(shareId, 'completed')
    const closed = await open(shareId, cookie)

    expect(closed.statusCode).toBe(404)
    expect(closed.body).toBe(guessed.body)
  })

  /**
   * The fifth wrong id, and the one that was reported (`#768`): the share
   * **token**, pasted here by an operator who had been handed two opaque
   * strings and no way to tell which door each opens. Against a `uuid` column
   * that is not a not-found but a raised error, so the console answered with
   * "something went wrong". The guard is in `shareOfferedTo` — where a real
   * database is what proves it, and where every caller inherits it — and this
   * asserts the door's half: nothing about it is a case of its own.
   */
  it('tells a share token what a guessed id is told', async () => {
    const cookie = await signedInCookie()
    const shareId = await anOffer()

    const guessed = await open(randomUUID(), cookie)
    const token = await open('QUJDRA-not-a-uuid_this-is-a-token', cookie)

    expect(token.statusCode).toBe(404)
    expect(token.body).toBe(guessed.body)
    expect((await open(shareId, cookie)).statusCode).toBe(200)
  })

  /**
   * **Rendering is not accepting** — the socket is. A person who opens the
   * window and wanders off has spent none of the live minutes, and the offer is
   * still there for them or for the next load.
   */
  it('does not start the session merely by being read', async () => {
    const cookie = await signedInCookie()
    const shareId = await anOffer()

    await open(shareId, cookie)

    expect(shares.all().find((one) => one.id === shareId)?.state).toBe('offered')
  })

  /**
   * A reload, a duplicated tab, a laptop that slept. The window answers a share
   * somebody is already on, because refusing here would end a live session over
   * a browser event nobody chose; whether *this* person may resume it is asked
   * again at the socket.
   */
  it('still answers once somebody is on it', async () => {
    const cookie = await signedInCookie()
    const shareId = await anOffer()

    const people = humans.people()
    const person = people[people.length - 1]
    if (person === undefined) throw new Error('nobody signed in')
    await shares.accept(shareId, person.id)

    expect((await open(shareId, cookie)).statusCode).toBe(200)
  })

  it('gives an agent reading JSON the same row rather than a page', async () => {
    const cookie = await signedInCookie()
    const shareId = await anOffer()

    const json = await app.inject({
      method: 'GET',
      url: `/browser/share/${shareId}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })

    expect(json.statusCode).toBe(200)
    expect(json.json().share.shareId).toBe(shareId)
    expect(json.json().share.purpose).toBe('The signup page wants a picture puzzle solved.')
  })
})
