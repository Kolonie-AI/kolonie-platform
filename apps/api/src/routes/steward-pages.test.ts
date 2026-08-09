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

/** One quest sitting in the queue, which is what makes a row exist to assert on. */
const aQuestAwaitingReview = async (): Promise<void> => {
  quests.credit(stewardId as never, 1_000_000)
  const authorId = String(store.issue({}).agent.id)
  quests.credit(authorId as never, 1000)
  const created = await quests.create({
    authorId: authorId as never,
    draft: {
      title: 'A thousand registrations',
      description: 'We want to know whether agents can register.',
      instructions: 'Register and report.',
      reward: { reputation: 5, lamports: 1 },
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
}

/**
 * The steward's two pages (`#181`).
 *
 * The queue is where a stranger's text is read and decided, and the numbers page
 * is the first surface on which the Colony's claims about itself can be checked
 * by anybody without database access.
 */
describe('the review queue', () => {
  it('shows who wrote it, the cost and the moderation result', async () => {
    quests.credit(stewardId as never, 1_000_000)
    const authorId = String(store.issue({}).agent.id)
    quests.credit(authorId as never, 1000)
    const created = await quests.create({
      authorId: authorId as never,
      draft: {
        title: 'A thousand registrations',
        description: 'We want to know whether agents can register.',
        instructions: 'Register and report.',
        reward: { reputation: 5, lamports: 1 },
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
    // *Sponsor* until `#468`. `kolonie-docs#184` lets the word stay in prose
    // where it says what somebody is doing — the paragraph above this table
    // still uses it that way — and retires it as a bare label, which reads as a
    // kind of person rather than a party to this quest.
    expect(page.body).toContain('Written by')
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

  /**
   * The basis a steward decides an account-using quest on (D-108, `#522`).
   *
   * **Beside the quest, and unconditionally.** The defect the rule answers is
   * two stewards deciding differently, and a rule that lives one click away is
   * consulted by whoever already suspected there was one. There is deliberately
   * no predicate: a prompt that fired on *some* quests would read as the Colony
   * having judged the others.
   */
  describe('the basis an account-using quest is decided on', () => {
    beforeEach(async () => {
      await aQuestAwaitingReview()
    })

    it('shows the one question a steward applies', async () => {
      const page = await asSteward('/review')

      expect(page.body).toContain('if this provider noticed, would the citizen lose its account?')
      expect(page.body).toContain('destroy a citizen\u2019s own property')
    })

    /**
     * **No list of permitted quest types**, which the issue forbids outright: a
     * catalogue is wrong within a month, a steward reads it as exhaustive, and a
     * quest nobody anticipated then gets refused for being unlisted.
     */
    it('enumerates nothing a sponsor is allowed to ask for', async () => {
      const body = (await asSteward('/review')).body.toLowerCase()

      // The quest is on the page, so an assertion about absence is about this
      // page's content rather than about an empty one.
      expect(body).toContain('a thousand registrations')
      for (const phrase of ['permitted quest', 'allowed quest', 'quest types', 'may ask for']) {
        expect(body).not.toContain(phrase)
      }
    })
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
        reward: { reputation: 5, lamports: 1 },
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
        reward: { reputation: 5, lamports: 1 },
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

/**
 * `#496`. Both review routes rendered `errorPage` when the domain **refused**
 * them — *"Something went wrong. The Colony could not answer that."* plus a uuid
 * nothing logged — for a 4xx whose reason the JSON branch of the same route
 * already sent to the caller.
 *
 * So a steward publishing a quest that had not cleared moderation was told the
 * Colony was broken, while an agent calling the same route one `Accept` header
 * away was told what to do about it.
 */
describe('when the Colony declines a review action', () => {
  /** A quest by somebody else, submitted and waiting — the ordinary case. */
  const aQuestInReview = async () => {
    const authorId = String(store.issue({}).agent.id)
    quests.credit(authorId as never, 1000)
    const created = await quests.create({
      authorId: authorId as never,
      draft: {
        title: 'A quest somebody else wrote',
        description: 'Not the steward’s own, so the review is an ordinary one.',
        instructions: 'Do it.',
        reward: { reputation: 5, lamports: 1 },
        slots: 10,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        questions: [{ key: 'how', prompt: 'How?' }],
      },
    })
    await quests.submit({
      authorId: authorId as never,
      taskId: created.task.id,
      at: new Date().toISOString() as never,
    })
    return created.task.id
  }

  const postAsBrowser = (url: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${stewardSession}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '',
    })

  const postAsAgent = (url: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        host: CONSOLE_HOST,
        accept: 'application/json',
        authorization: `Bearer ${stewardKey}`,
      },
    })

  /**
   * The reason `publishQuest` actually returns for a quest that has not cleared
   * moderation, which is the case the issue opens on.
   */
  it('tells the steward why, in the words the JSON caller gets', async () => {
    const taskId = await aQuestInReview()

    const response = await postAsBrowser(`/review/${taskId}/publish`)

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(response.statusCode).toBeLessThan(500)
    expect(response.body).toContain('has not cleared moderation')
    expect(response.body).toContain('That did not go through')
  })

  /**
   * **No crash page, and no id.** Printing no id is honest; printing one that
   * reaches no log costs the reader a support round-trip to discover it leads
   * nowhere — which is the worse half of this defect.
   */
  it('renders no error page and no error id for a refusal', async () => {
    const taskId = await aQuestInReview()

    const response = await postAsBrowser(`/review/${taskId}/publish`)

    expect(response.body).not.toContain('Error id:')
    expect(response.body).not.toContain('Something went wrong')
    expect(response.body).not.toContain('could not answer that')
  })

  /** They land back on the queue they came from, with it still readable. */
  it('brings them back to the queue rather than to a dead end', async () => {
    const taskId = await aQuestInReview()

    const response = await postAsBrowser(`/review/${taskId}/publish`)

    expect(response.body).toContain('Review queue')
    expect(response.body).toContain('A steward publishes or refuses, and never edits')
  })

  it('does the same for a refusal that is declined', async () => {
    const taskId = await aQuestInReview()

    const response = await postAsBrowser(`/review/${taskId}/refuse`)

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(response.body).not.toContain('Error id:')
    expect(response.body).toContain('Review queue')
  })

  /**
   * The refusal a steward gets for its **own** quest — D-052, and a different
   * reason reaching the same page, so this is not one message hard-coded.
   */
  it('carries a different reason for a different refusal', async () => {
    quests.credit(stewardId as never, 1000)
    const created = await quests.create({
      authorId: stewardId as never,
      draft: {
        title: 'My own quest',
        description: 'Written by the steward reading this.',
        instructions: 'Do it.',
        reward: { reputation: 5, lamports: 1 },
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

    const response = await postAsBrowser(`/review/${created.task.id}/publish`)

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(response.body).toContain('That did not go through')
    expect(response.body).not.toContain('Error id:')
  })

  /**
   * **The JSON representation is unchanged** — it was already right, and this
   * issue is about the other branch of the same `if`.
   */
  it('leaves the JSON representation exactly as it was', async () => {
    const taskId = await aQuestInReview()

    const response = await postAsAgent(`/review/${taskId}/publish`)

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    const body = response.json() as { code?: string; message?: string }
    expect(body.code).toEqual(expect.any(String))
    expect(body.message).toContain('has not cleared moderation')
  })

  /**
   * **The status stays the rejection's own.** A refusal answered `200` is a
   * refusal nothing downstream can tell from a success — and re-rendering the
   * queue is exactly the shape that would tempt somebody to make it one.
   */
  it('answers the rejection’s status and not 200', async () => {
    const taskId = await aQuestInReview()

    const asHtml = await postAsBrowser(`/review/${taskId}/publish`)
    const asJson = await postAsAgent(`/review/${taskId}/publish`)

    expect(asHtml.statusCode).toBe(asJson.statusCode)
    expect(asHtml.statusCode).not.toBe(200)
  })
})
