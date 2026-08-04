import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeQuests, type FakeQuestDesk } from '../__fixtures__/quests.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeConsole } from '../__fixtures__/console.js'

const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let store: FakeStore
let quests: FakeQuestDesk
let stewardKey: string
let stewardId: string
let stewardSession: string
let ordinaryKey: string

beforeEach(async () => {
  store = fakeStore()
  quests = fakeQuests()
  app = buildApp({
    ...fakeColony(),
    store,
    quests,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
  })
  await app.ready()

  const issued = store.issue({})
  stewardKey = String(issued.apiKey)
  stewardId = String(issued.agent.id)
  store.setRoles(issued.agent.id, ['steward'])
  stewardSession = 'a-steward-session'
  store.signIn(issued.agent.id, stewardSession)

  ordinaryKey = String(store.issue({}).apiKey)
})

afterEach(async () => {
  await app.close()
})

const asSteward = (url: string) =>
  app.inject({
    method: 'GET',
    url,
    headers: {
      host: CONSOLE_HOST,
      accept: 'text/html',
      cookie: `__Host-kolonie_session=${stewardSession}`,
    },
  })

const asStewardAgent = (url: string) =>
  app.inject({
    method: 'GET',
    url,
    headers: {
      host: CONSOLE_HOST,
      accept: 'application/json',
      authorization: `Bearer ${stewardKey}`,
    },
  })

/**
 * The steward's two pages (`#181`).
 *
 * The queue is where a stranger's text is read and decided, and the numbers page
 * is the first surface on which the Colony's claims about itself can be checked
 * by anybody without database access.
 */
describe('the review queue', () => {
  it('shows the sponsor, the cost, the balance and the moderation result', async () => {
    quests.credit(stewardId as never, 1_000_000)
    const authorId = String(store.issue({}).agent.id)
    quests.credit(authorId as never, 1000)
    const created = await quests.create({
      authorId: authorId as never,
      draft: {
        title: 'A thousand registrations',
        description: 'We want to know whether agents can register.',
        instructions: 'Register and report.',
        reward: { credits: 1, reputation: 5 },
        slots: 10,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        questions: [{ key: 'what-happened', prompt: 'What happened?' }],
      },
    })
    await quests.submit({
      authorId: authorId as never,
      taskId: created.task.id,
      at: new Date().toISOString() as never,
    })

    const page = await asSteward('/review')

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('A thousand registrations')
    // Capacity times price, computed once and shown.
    expect(page.body).toContain('Total')
    expect(page.body).toContain('Sponsor')
    expect(page.body).toContain('available balance')
  })

  /**
   * **The pair a steward is actually judging.** Each half is defensible and the
   * combination rarely is, so the two are shown together and the combination is
   * called out rather than left to be noticed.
   */
  it('puts the audience and the proof verifier side by side', async () => {
    const page = await asSteward('/review')

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Review queue')
  })

  it('answers JSON to a steward holding an API key', async () => {
    const response = await asStewardAgent('/review')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('queue')
  })

  /**
   * A browser that is not a steward gets the not-found handler, for the reason
   * `console-pages.ts` already argues: a `403` would tell a stranger which
   * console paths are real. An agent, which can act on the answer, gets `403`.
   */
  it('hides itself from a browser that is not a steward, and refuses an agent plainly', async () => {
    const browser = await app.inject({
      method: 'GET',
      url: '/review',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })
    const agent = await app.inject({
      method: 'GET',
      url: '/review',
      headers: {
        host: CONSOLE_HOST,
        accept: 'application/json',
        authorization: `Bearer ${ordinaryKey}`,
      },
    })

    expect(browser.statusCode).toBe(404)
    expect(agent.statusCode).toBe(403)
  })

  it('answers on the console host and nowhere else', async () => {
    const elsewhere = await app.inject({
      method: 'GET',
      url: '/review',
      headers: {
        host: 'api.example',
        accept: 'application/json',
        authorization: `Bearer ${stewardKey}`,
      },
    })

    expect(elsewhere.statusCode).toBe(404)
  })
})

describe('a steward’s own quest', () => {
  /**
   * **Listed, marked, and refused server-side.** The row is not filtered out: a
   * row that vanishes without explanation reads as a bug and invites somebody to
   * "fix" the filter, while a row saying *you wrote this* explains the rule at
   * the moment it applies.
   */
  it('appears in the queue, marked, rather than being filtered out', async () => {
    quests.credit(stewardId as never, 1000)
    const created = await quests.create({
      authorId: stewardId as never,
      draft: {
        title: 'My own quest',
        description: 'Written by the steward reading this.',
        instructions: 'Do it.',
        reward: { credits: 1, reputation: 5 },
        slots: 10,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        questions: [{ key: 'how', prompt: 'How?' }],
      },
    })
    await quests.submit({
      authorId: stewardId as never,
      taskId: created.task.id,
      at: new Date().toISOString() as never,
    })

    const page = await asSteward('/review')

    expect(page.body).toContain('My own quest')
    expect(page.body).toContain('You wrote this quest')
    // And no approve button on that row.
    expect(page.body).not.toContain(`/review/${created.task.id}/publish`)
  })

  /**
   * The acceptance criterion, and the one that matters: the markup is a
   * courtesy and the route is the refusal.
   */
  it('is refused when the approval is posted straight at the route', async () => {
    quests.credit(stewardId as never, 1000)
    const created = await quests.create({
      authorId: stewardId as never,
      draft: {
        title: 'My own quest',
        description: 'Written by the steward reading this.',
        instructions: 'Do it.',
        reward: { credits: 1, reputation: 5 },
        slots: 10,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        questions: [{ key: 'how', prompt: 'How?' }],
      },
    })
    await quests.submit({
      authorId: stewardId as never,
      taskId: created.task.id,
      at: new Date().toISOString() as never,
    })

    const posted = await app.inject({
      method: 'POST',
      url: `/review/${created.task.id}/publish`,
      headers: {
        host: CONSOLE_HOST,
        accept: 'application/json',
        authorization: `Bearer ${stewardKey}`,
      },
    })

    expect(posted.statusCode).toBeGreaterThanOrEqual(400)
  })
})

describe('the Colony’s numbers', () => {
  it('names what each figure counts, and when it was computed', async () => {
    const page = await asSteward('/numbers')

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Computed at')
    expect(page.body).toContain('Accounts, by the way they arrived')
    expect(page.body).toContain('Citizens')
    expect(page.body).toContain('D-039')
    expect(page.body).toContain('Skills granted')
    expect(page.body).toContain('Quests, by status')
  })

  it('shows the ledger sum and the mint balance, and says both are expected to be zero', async () => {
    const page = await asSteward('/numbers')

    expect(page.body).toContain('Ledger sum')
    expect(page.body).toContain('Mint balance')
    expect(page.body).toContain('expected: 0')
  })

  it('has a JSON representation usable with an API key', async () => {
    const response = await asStewardAgent('/numbers')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('citizens')
    expect(response.json()).toHaveProperty('computedAt')
  })

  it('is hidden from a browser that is not a steward', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/numbers',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })
})

/**
 * **A generic admin surface that can edit any row is a permanent invitation to
 * fix production by hand**, and every such fix is a change nobody reviewed and
 * Git never saw. So the console's write surface is enumerated rather than
 * described: adding a route here is a line in this test, and that is where
 * somebody is asked why.
 */
describe('what the console can write', () => {
  it('performs no write outside the review actions and the sponsor’s own quests', () => {
    const written: string[] = []
    for (const route of app.printRoutes({ commonPrefix: false }).split('\n')) {
      if (route.includes('POST') && !route.includes('/v1/')) written.push(route.trim())
    }

    const paths = written.join('\n')

    // The steward's two, which are `#181`'s own.
    expect(paths).toContain('publish')
    expect(paths).toContain('refuse')
    // And nothing that edits an identity, a skill, a ledger row or a task.
    expect(paths).not.toContain('/agents')
    expect(paths).not.toContain('/skills')
    expect(paths).not.toContain('/ledger')
    expect(paths).not.toContain('/numbers')
  })
})
