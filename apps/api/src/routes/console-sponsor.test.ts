import { API_BASE_PATH } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { anAgent, type FakeHumanStore } from '../__fixtures__/humans.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { SESSION_COOKIE } from './console.js'

let app: FastifyInstance
let colony: FakeColony
/**
 * Held separately because `FakeColony` types this as the `AgentStore` the routes
 * see, and one assertion below needs the fixture's own key issuer — the same
 * arrangement `deposits.test.ts` uses.
 */
let store: FakeStore
/**
 * Held for the same reason: `FakeColony` types the human store as the port the
 * routes see, and two assertions below put a sponsor identity on record without
 * going through `openSponsor`.
 */
let people: FakeHumanStore

beforeEach(async () => {
  store = fakeStore()
  colony = { ...fakeColony(), store }
  people = colony.humans.store as FakeHumanStore
  app = buildApp(colony)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

/** A person at a browser, signed in and holding nothing else. */
const signedIn = async () => {
  const { human } = await colony.humans.store.findOrCreate({
    provider: 'github',
    subject: `subject-${Math.trunc(performance.now() * 1000)}`,
    email: 'someone@example.test',
  })
  const opened = await colony.humans.store.openSession(human.id, {})
  return { human, cookie: `${SESSION_COOKIE}=${opened.session}` }
}

const post = (url: string, cookie?: string, body?: unknown) =>
  app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}${url}`,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
    payload: body ?? {},
  })

/**
 * `#430`: the one step of the sponsor path a person could not finish alone.
 *
 * `kolonie.ai/sponsors` step 5 named it — the deposit address is handed over the
 * API and not shown in the console. These assert the two halves that close it:
 * a person can open an identity from a session, and the routes that identity
 * needs accept the session.
 */
describe('a sponsor identity on a human account', () => {
  it('opens one for a signed-in person who holds none', async () => {
    const { cookie } = await signedIn()

    const response = await post('/console/sponsor', cookie)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ created: true })
    expect((response.json() as { sponsor: { name: string } }).sponsor.name).toMatch(/^sponsor-/)
  })

  /**
   * *One is the thing being paid for; two is an org feature, and organisations
   * are not in this design.* A second call is not a refusal, because *opened*
   * and *already held* mean the same thing to whoever clicked.
   */
  it('answers the one already held rather than opening a second', async () => {
    const { cookie } = await signedIn()

    const first = await post('/console/sponsor', cookie)
    const second = await post('/console/sponsor', cookie)

    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ created: false })
    expect((second.json() as { sponsor: { id: string } }).sponsor.id).toBe(
      (first.json() as { sponsor: { id: string } }).sponsor.id,
    )
  })

  it('refuses anybody not signed in as a person, and says nothing more', async () => {
    const anonymous = await post('/console/sponsor')
    const nonsense = await post('/console/sponsor', `${SESSION_COOKIE}=not-a-session`)

    expect(anonymous.statusCode).toBe(401)
    // Identical, because there is nothing to disclose in the difference between
    // no cookie and a cookie that resolves to nobody.
    expect(nonsense.statusCode).toBe(401)
    expect(nonsense.json()).toEqual(anonymous.json())
  })

  /**
   * The deposit address is the step `#400` was open for, and the reason this
   * issue exists. It is asserted through the session with no `Authorization`
   * header anywhere in the request.
   */
  it('lets that person read a deposit address in a browser, with no key', async () => {
    const { human, cookie } = await signedIn()
    const sponsor = anAgent()
    people.holdsSponsor(human.id, sponsor)

    const response = await post('/deposits/address', cookie)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('address')
  })

  /**
   * **The half that must not have broken.** `routes/console.ts`: an agent
   * *"must never be told to open a browser in order to be a sponsor"*. The key
   * is tried first and unchanged, so this path is the one it always was.
   */
  it('still lets an agent do it with an API key and no browser', async () => {
    const { apiKey } = store.issue({})

    const response = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/deposits/address`,
      headers: { authorization: `Bearer ${apiKey}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('address')
  })

  /**
   * Signed in is not the same as holding an identity, and the refusal must not
   * say which of the two happened — a distinguishable one would tell a caller
   * *this browser is signed in* without it having established that.
   */
  it('refuses a signed-in person who has never opened one, exactly as an absent key is refused', async () => {
    const { cookie } = await signedIn()

    const withSession = await post('/deposits/address', cookie)
    const withNothing = await post('/deposits/address')

    expect(withSession.statusCode).toBe(401)
    expect(withSession.json()).toEqual(withNothing.json())
    expect(withSession.headers['www-authenticate']).toBe(withNothing.headers['www-authenticate'])
  })

  it('lets that person write a quest in a browser too', async () => {
    const { human, cookie } = await signedIn()
    people.holdsSponsor(human.id, anAgent())

    const response = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/quests`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
  })
})
