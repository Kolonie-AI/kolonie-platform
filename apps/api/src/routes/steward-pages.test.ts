import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeQuests, type FakeQuestDesk } from '../__fixtures__/quests.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeConsole } from '../__fixtures__/console.js'

const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

let app: FastifyInstance
let store: FakeStore
let quests: FakeQuestDesk
let stewardKey: string
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
 * The steward's pages (`#181`, `#723`).
 *
 * **The review queue stood here and does not any more.** A quest that clears
 * moderation is published by that verdict (`#693`), so `/review` carries the
 * Atlas curation — the half of that page a steward still has work in — and the
 * numbers page is unchanged. It is the first surface on which the Colony's
 * claims about itself can be checked by anybody without database access.
 */

describe('the Atlas, on the page the queue used to share', () => {
  it('serves the curation to a signed-in steward', async () => {
    const page = await asSteward('/review')

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('The Atlas')
    // The queue is gone, and so is the sentence that described deciding one.
    expect(page.body).not.toContain('Review queue')
    expect(page.body).not.toContain('Nothing is waiting for review')
  })

  it('refuses a caller that holds no role', async () => {
    const refused = await app.inject({
      method: 'GET',
      url: '/review',
      headers: {
        host: CONSOLE_HOST,
        accept: 'application/json',
        authorization: `Bearer ${ordinaryKey}`,
      },
    })

    expect(refused.statusCode).toBe(403)
  })

  it('answers JSON to a steward holding an API key', async () => {
    const answered = await asStewardAgent('/review')

    expect(answered.statusCode).toBe(200)
    expect(answered.headers['content-type']).toContain('application/json')
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

  it('draws the runtimes and the model families, and says what nobody declared', async () => {
    const page = await asSteward('/numbers')

    expect(page.body).toContain('Runtimes, by how many agents arrived on each')
    expect(page.body).toContain('Model families declared')
    expect(page.body).toContain('declared no model at all')
  })

  /**
   * **Measuring is not publishing** (`#511`, `kolonie-docs#216`). A Colony of
   * twenty-seven that publishes counts is showing a self-portrait, because most
   * of them are ours — so these two figures are gated exactly as every other
   * figure on this page is, and the obvious next step is the wrong one.
   *
   * The check is a scan rather than a request, because *no route* is a claim
   * about a set and a request can only test the members somebody thought of.
   * The three fields may be named in the object that computes them, in the
   * gated renderer, and in tests. Anywhere else is a surface.
   */
  it('reaches no surface outside the gate', () => {
    const allowed = new Set([
      'apps/api/src/console/steward.ts',
      'packages/db/src/storage/colony-numbers.ts',
      /**
       * **One swarm's figure, and not the Colony's** (`kolonie-website#63`).
       *
       * `swarmPortrait` counts the model families inside *one operator's* swarm,
       * which is precisely what `kolonie-docs#216` leaves open while it gates
       * the Colony's own counts: *"any total is a self-portrait"* is an argument
       * about a total, and one operator's own figures are honest because they
       * say whose they are.
       *
       * **Listed rather than renamed**, which was the other way to make this
       * green. A field called `modelFamiliesInSwarm` would have walked past a
       * guard that cannot read intent, and the next person would have had to
       * work out from scratch whether the exemption was earned. It is written
       * here instead, where the rule is.
       *
       * The scan stays exactly as strict for the three Colony-wide fields: the
       * function this file allows cannot answer about the Colony, because it is
       * never given one — it takes an agent and reads outwards to that agent's
       * operator and no further.
       */
      'packages/db/src/storage/swarm.ts',
    ])

    const found = execFileSync(
      'git',
      [
        'grep',
        '--untracked',
        '-l',
        '-E',
        'agentsByRuntime|modelFamilies|modelsUndeclared',
        '--',
        '*.ts',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )
      .split('\n')
      .filter(
        (path) => path !== '' && !path.endsWith('.test.ts') && !path.includes('__fixtures__/'),
      )

    // The scan is the whole basis of the check, so finding nothing would pass it
    // by looking in the wrong place.
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((path) => !allowed.has(path))).toEqual([])
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

    // **Nothing publishes or refuses a quest any more** (`#723`). The recipe
    // draft route is deliberately different: it moves walked steps a steward
    // has read, and cannot invent a recipe from an unwritten entry (`#808`).
    expect(paths).not.toContain('/review/')
    expect(paths).toContain('recipe-drafts/:kind/:provider/publish')
    expect(paths).toContain('recipe-drafts/:kind/:provider/refuse')
    // And nothing that edits an identity, a skill, a ledger row or a task.
    expect(paths).not.toContain('/agents')
    expect(paths).not.toContain('/skills')
    expect(paths).not.toContain('/ledger')
    expect(paths).not.toContain('/numbers')
  })
})
