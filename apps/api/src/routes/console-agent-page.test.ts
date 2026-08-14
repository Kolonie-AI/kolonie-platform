import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeQuests, type FakeQuestDesk } from '../__fixtures__/quests.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * The agent page (`#452`).
 *
 * **A window rather than a control panel**, and that is the property most of
 * these tests are circling. The page assembles what the Colony already holds
 * about one agent for the person paying for its runtime. The operator may revise
 * its own consent, but nothing here changes the agent's identity or standing,
 * and an agent somebody does not operate is indistinguishable from one that does
 * not exist.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let pages: ReturnType<typeof fakeOperatorPages>
let contracts: ReturnType<typeof fakeAutonomyStore>
let quests: FakeQuestDesk
let agentId: AgentId
let strangersAgentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  pages = fakeOperatorPages()
  contracts = fakeAutonomyStore()
  quests = fakeQuests()
  const agents = fakeStore()

  app = buildApp({
    ...fakeColony(),
    store: agents,
    quests,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
    autonomy: {
      store: contracts,
      pages,
      mailer: fakeAutonomyMailer(),
      formBaseUrl: CONSOLE_URL,
    },
    // The same page store on all three, as production has it: a token resolves
    // an exchange and a note, so a second store here would let this file write
    // through a link the revoke path had never heard of.
    operatorRequests: fakeOperatorRequests({ pages }),
    operatorNotes: fakeOperatorNotes({ pages }),
  })
  await app.ready()

  agentId = agents.issue().agent.id
  strangersAgentId = agents.issue().agent.id
  pages.exists(agentId)
  pages.exists(strangersAgentId)
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

/** Through the code path `#426` built, so this authorises against the table the route reads. */
const link = async (id: AgentId): Promise<void> => {
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, human.id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
}

const openPage = (cookie: string, id: AgentId, zone = 'Europe/Berlin') =>
  app.inject({
    method: 'GET',
    url: `/agents/${id}`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie, 'cf-timezone': zone },
  })

/**
 * One of the agent's own pages (`#797`).
 *
 * The sections these open used to be `#anchor`s on the page above, which is
 * why several tests in this file follow their subject here rather than
 * asserting it on the overview.
 */
const openSection = (cookie: string, id: AgentId, slug: string, zone = 'Europe/Berlin') =>
  app.inject({
    method: 'GET',
    url: `/agents/${id}/${slug}`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie, 'cf-timezone': zone },
  })

describe('the agent page', () => {
  it('shows identity, standing, balance and activity behind a session', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    pages.nameFor(agentId, 'canary')
    pages.factsFor(agentId, {
      skills: ['mailbox', 'profile'],
      lastSeenAt: new Date(Date.now() - 2 * 3_600_000).toISOString() as never,
      attempts: [
        {
          rung: 'email-inbox',
          kind: 'academy',
          at: new Date().toISOString() as never,
          outcome: 'passed',
        },
      ],
    })

    const response = await openPage(cookie, agentId)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('canary')
    expect(response.body).toContain('Standing')
    // No `Balance` heading since `#553`: the Colony holds none. The Wallet page
    // is what stands there now, and `#573`'s tests cover it.
    expect(response.body).not.toContain('<h2>Balance</h2>')
    expect(response.body).toContain('2 hours ago')
    // **The sections are pages since `#797`**, so what the overview carries of
    // them is a line each and a link. What is *in* them is asserted where it
    // renders, which is the point of the change.
    expect(response.body).toContain(`href="/agents/${agentId}/wallet"`)
    expect((await openSection(cookie, agentId, 'skills')).body).toContain('mailbox')
    expect((await openSection(cookie, agentId, 'activity')).body).toContain('email-inbox')
  })

  /**
   * **Every page in the navigation answers** (`#797`), which is the criterion
   * *a path that answers today keeps answering* in the form a test can hold.
   * The crawl in `console-links.test.ts` proves the console emits no link that
   * 404s; this proves the ten it emits here are these ten.
   */
  it('answers on every one of the agent’s own pages', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    pages.nameFor(agentId, 'canary')

    for (const slug of [
      'wallet',
      'skills',
      'rungs',
      'activity',
      'quests',
      'quests-written',
      'accounts',
      'autonomy',
      'profile',
    ]) {
      const response = await openSection(cookie, agentId, slug)
      expect(response.statusCode, slug).toBe(200)
      // Each carries the console's own navigation, which is what a reader on a
      // phone gets instead of the contents column this replaced.
      expect(response.body, slug).toContain('<nav class="console-nav"')
      expect(response.body, slug).toContain(`href="/agents/${agentId}"`)
    }
  })

  /**
   * **The rejection case, on every new path.** `operatedAgent` is the one gate,
   * so an agent somebody does not operate is indistinguishable from one that
   * does not exist here exactly as it is on the page above.
   */
  it('answers a stranger’s agent as missing on every one of them', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    for (const slug of [
      'wallet',
      'skills',
      'rungs',
      'activity',
      'quests',
      'quests-written',
      'accounts',
      'autonomy',
      'profile',
    ]) {
      expect((await openSection(cookie, strangersAgentId, slug)).statusCode, slug).toBe(404)
    }
  })

  /**
   * **The mobile regression, stated as a check** (`#797`).
   *
   * The contents column `#583` added was in a grid track that appeared only
   * from 75rem, so the reader it was built for — somebody scrolling a long page
   * on a phone — never saw it. What replaced it is the console's own navigation,
   * which is a `<details>` element in normal flow: there is no width at which it
   * is not rendered, and the assertion is that no rule hides it at one.
   */
  it('draws the agent’s pages at every width, and no contents column at any', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openPage(cookie, agentId)).body

    expect(body).toContain('<nav class="console-nav"')
    expect(body).not.toContain('page-contents')
    // Nothing in the stylesheet gates the navigation on a viewport width, and
    // nothing declares it hidden. A media query that added one would fail here.
    // The one `display: none` the navigation does carry is on a pseudo-element
    // — the browser's own disclosure triangle, replaced by a drawn one — and
    // the selector boundary is what keeps it out of this.
    const styles = body.slice(body.indexOf('<style'), body.indexOf('</style>'))
    expect(styles).not.toMatch(
      /\.console-nav(\s+(details|summary|ul|li))?\s*\{[^}]*display:\s*none/,
    )
    expect(styles).not.toContain('.page-contents')
  })

  /**
   * **The rejection case, and it is the one that matters.** A page that answered
   * differently for *not yours* and *does not exist* would be a way to find out
   * which agent ids are real from a console session.
   */
  it('answers an agent this person does not operate exactly as a missing one', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const strangers = await openPage(cookie, strangersAgentId)
    const nobodys = await openPage(cookie, '99999999-9999-4999-8999-999999999999' as AgentId)

    expect(strangers.statusCode).toBe(404)
    expect(nobodys.statusCode).toBe(404)
    expect(strangers.body).toBe(nobodys.body)
  })

  it('is not reachable without a session at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * **This is what `#451`'s link was landing on.** The mailed door needs a live
   * operator page and 404s without one; the console's page is reached through
   * the join table and does not care whether a citizen ever mailed anybody.
   */
  it('opens for an agent that has never issued an operator page', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    expect(await pages.liveToken(agentId)).toBeUndefined()
    expect((await openPage(cookie, agentId)).statusCode).toBe(200)
  })

  /**
   * **An agent that has done nothing gets sentences, not dashes.** This is the
   * case the page has to say something about, because it is what a person sees
   * on the day they set an agent up.
   */
  it('renders a deliberate empty state that says what happens next', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openPage(cookie, agentId)).body

    expect(body).toContain('None held yet')
    expect(body).toContain('Nothing attempted yet')
    expect(body).not.toContain('<td>—</td>')
    // `Nothing on account` went with the balance block (`#553`). The empty state
    // that replaced it says whose step the wallet is, and since `#797` it says
    // it on the wallet page — the line above it only says there is nothing yet.
    expect(body).toContain('No wallet proved yet')
    expect((await openSection(cookie, agentId, 'wallet')).body).toContain(
      'has not proved a wallet yet',
    )
  })

  /**
   * **`#454` step 2 is not here and ships no placeholder.** Which quests an
   * agent *created* waits on a sponsor model that is not settled, and a section
   * promising it would be the empty heading that issue refuses by name.
   */
  it('promises no quests-created section it cannot deliver', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openPage(cookie, agentId)).body

    expect(body).not.toContain('Quests created')
    expect(body).not.toContain('coming soon')
  })

  /** And what it *did* take part in is there, with the empty state that says so. */
  it('says what would put a quest there, for an agent with none', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openSection(cookie, agentId, 'quests')).body

    expect(body).toContain('<h1>Quests</h1>')
    expect(body).toContain('None yet')
    expect(body).toContain('finds paid work itself')
    // And the page above says the same thing in one line, which is what a
    // reader deciding whether to open it needs.
    expect((await openPage(cookie, agentId)).body).toContain('None taken yet')
  })

  /** Its one permission write changes the operator's agreement, not the agent's identity. */
  it('offers no control beyond revising the operator’s own consent', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openPage(cookie, agentId)).body

    expect(body).toContain('a window rather than a control panel')
    /**
     * **Every form on this page is named.** Notes reach words, wishes reach a
     * shared plan, and autonomy reaches only the operator's own permission.
     *
     * This was *no form posting at this agent at all* until `#527`, and it held
     * only because the fixture has no operator page: `#453`'s note form posts to
     * `/agents/:id/operator` and would have tripped it the moment a citizen
     * issued one. An assertion that passes for the wrong reason is worse than
     * one that lists what it allows, so this lists them.
     *
     * - `…/operator` — a message to the citizen. D-081: words, never a
     *   permission.
     * - `…/wishes`, `…/wishes/want`, `…/wishes/remove` — the shared account
     *   list (`#527`). A plan both parties write; nothing on it starts anything,
     *   and the mark is what the operator has to make before a recipe may ask
     *   them for anything.
     * - `…/autonomy` — the operator's own consent, versioned and reported to the
     *   citizen at its next waking.
     *
     * Nothing else may appear here without being argued for in this list.
     */
    const actions = [...body.matchAll(/<form[^>]*action="([^"]+)"/g)].map((match) => match[1])
    for (const action of actions) {
      expect(
        action?.startsWith(`/agents/${agentId}/wishes`) === true ||
          action === `/agents/${agentId}/operator` ||
          action === `/agents/${agentId}/autonomy` ||
          action?.startsWith('/agents/') !== true,
        `unexpected form target on the agent page: ${String(action)}`,
      ).toBe(true)
    }

    expect(body).not.toContain('<script')
  })

  describe('revising the autonomy contract', () => {
    it('opens and answers the form without an invitation from the agent', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const form = await app.inject({
        method: 'GET',
        url: `/agents/${agentId}/autonomy`,
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      })
      expect(form.statusCode).toBe(200)
      expect(form.body).toContain(`action="/agents/${agentId}/autonomy"`)

      const recorded = await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/autonomy`,
        payload: new URLSearchParams({
          level: 'accompanied',
          challengesAllowed: 'no',
          defaultRule: 'refrain',
          operatorRoute: 'Use the console.',
        }).toString(),
        headers: {
          host: CONSOLE_HOST,
          accept: 'text/html',
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
      })

      expect(recorded.statusCode).toBe(200)
      expect((await contracts.read(agentId))?.level).toBe('accompanied')
      expect(recorded.body).toContain('will be told at its next waking')
    })

    it('keeps the earlier version after a revision', async () => {
      const cookie = await signedInCookie()
      await link(agentId)
      contracts.grant(agentId, {
        level: 'free',
        challengesAllowed: true,
        defaultRule: 'ask',
        operatorRoute: 'Use mail.',
      })

      await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/autonomy`,
        payload: new URLSearchParams({
          level: 'accompanied',
          challengesAllowed: 'no',
          defaultRule: 'refrain',
          operatorRoute: 'Use the console.',
        }).toString(),
        headers: {
          host: CONSOLE_HOST,
          accept: 'text/html',
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
      })

      expect((await contracts.history(agentId)).map((version) => version.level)).toEqual([
        'accompanied',
        'free',
      ])
      // The history and the form that revises it are one page since `#797`:
      // *what may this agent do* and *change what it may do* are one question.
      expect((await openSection(cookie, agentId, 'autonomy')).body).toContain('Previous version 1')
    })

    it('is unreachable for an agent this person does not operate', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const response = await app.inject({
        method: 'GET',
        url: `/agents/${strangersAgentId}/autonomy`,
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      })
      expect(response.statusCode).toBe(404)
    })
  })

  /** `#461`'s rule reaches this page too: no time is printed without its clock. */
  it('renders its dates in the visitor’s zone', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    expect((await openPage(cookie, agentId)).body).toContain('Europe/Berlin')
    expect((await openPage(cookie, agentId, 'nonsense')).body).toContain('UTC')
  })

  /** An agent may drive the console with its key, so this answers JSON as well. */
  it('answers the same page as JSON', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}`,
      headers: { host: CONSOLE_HOST, accept: 'application/json', cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ name: 'canary', citizenship: 'candidate' })
  })

  /**
   * **What the agent has been paid for** (`#454`, step 1).
   *
   * Quests it took part in, from the store the console's own quest pages read.
   * What it *created* waits on a sponsor model that is not settled and ships no
   * placeholder here.
   */
  describe('quests it took part in', () => {
    it('lists them newest first, with the outcome', async () => {
      const cookie = await signedInCookie()
      await link(agentId)
      quests.tookPartIn(agentId, {
        questId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as never,
        title: 'A thousand registrations',
        at: new Date(Date.now() - 3 * 86_400_000).toISOString() as never,
        outcome: 'accepted',
      })
      quests.tookPartIn(agentId, {
        questId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as never,
        title: 'A survey nobody wanted',
        at: new Date(Date.now() - 86_400_000).toISOString() as never,
        outcome: 'refused',
      })

      const body = (await openSection(cookie, agentId, 'quests')).body

      expect(body).toContain('A thousand registrations')
      expect(body).toContain('accepted')
      expect(body).toContain('refused')
      expect(body.indexOf('A survey nobody wanted')).toBeLessThan(
        body.indexOf('A thousand registrations'),
      )
      // The overview counts them and names the newest moment, and carries
      // neither title: one read, said twice as far as it is useful.
      expect((await openPage(cookie, agentId)).body).toContain('2 taken, the last')
    })

    /**
     * **What it did, never what it wrote.** `#328` took the citizen's handle off
     * even the sponsor's copy of an answer; an operator is a third party to that
     * exchange, so the answers are not on this page at all.
     */
    it('shows no answers', async () => {
      const cookie = await signedInCookie()
      await link(agentId)
      quests.tookPartIn(agentId, {
        questId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as never,
        title: 'A quest',
        at: new Date().toISOString() as never,
        outcome: 'accepted',
      })

      const body = (await openSection(cookie, agentId, 'quests')).body

      expect(body).toContain('A quest')
      expect(body).not.toContain('answers')
    })

    /** Nothing here lets a human act on a quest on the agent's behalf. */
    it('offers no control over any of them', async () => {
      const cookie = await signedInCookie()
      await link(agentId)
      quests.tookPartIn(agentId, {
        questId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as never,
        title: 'A quest',
        at: new Date().toISOString() as never,
        outcome: 'waiting',
      })

      const body = (await openSection(cookie, agentId, 'quests')).body

      expect(body).not.toContain('Withdraw')
      expect(body).not.toContain('Resubmit')
      expect(body).not.toMatch(/<form[^>]*action="\/quests\//)
    })
  })

  /**
   * **The operator view is a section of this page now** (`#453`) — one of
   * several things you do on an agent's page rather than the only thing there
   * is.
   */
  describe('the operator view, folded in', () => {
    /**
     * **A line to the door rather than the form itself, since `#797`.** Folding
     * the form in meant every read of the page above opened the door and moved
     * its `lastOpenedAt`, so a person looking at their own agent looked like the
     * operator arriving. `/agents/:agentId/operator` existed before this page
     * did and is where the form lives.
     */
    it('leads to the door once the citizen has issued a page', async () => {
      const cookie = await signedInCookie()
      await link(agentId)
      await pages.issue(agentId, 'op@example.org')

      const body = (await openPage(cookie, agentId)).body

      expect(body).toContain('Leaving this agent a note')
      expect(body).toContain(`href="/agents/${agentId}/operator"`)
      expect(body).not.toContain(`action="/agents/${agentId}/operator"`)
      expect((await openSection(cookie, agentId, 'operator')).body).toContain(
        `action="/agents/${agentId}/operator"`,
      )
    })

    /**
     * `#428`: no live page means no door, and that holds whichever side the
     * door is on. The page is complete without it rather than showing an empty
     * section somebody cannot use.
     */
    it('draws no section for an agent that has issued none', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const body = (await openPage(cookie, agentId)).body

      expect(body).not.toContain('Leaving this agent a note')
      expect(body).not.toContain(`action="/agents/${agentId}/operator"`)
    })

    /** **The token never reaches a page behind a login.** `#428`'s rule, unchanged. */
    it('carries no token', async () => {
      const cookie = await signedInCookie()
      await link(agentId)
      const token = await pages.issue(agentId, 'op@example.org')

      expect((await openPage(cookie, agentId)).body).not.toContain(token)
    })

    /**
     * **The rejection case `#453` asks for.** A console write reaches exactly
     * what a mailed-link write reaches — words, and never a permission. The
     * section posts to the handlers `#428` built and nothing widened them, so a
     * body naming a permission is refused rather than acted on.
     */
    it('reaches words and never a permission', async () => {
      const cookie = await signedInCookie()
      await link(agentId)
      await pages.issue(agentId, 'op@example.org')

      const attempt = await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/operator`,
        payload: new URLSearchParams({
          intent: 'note',
          body: 'a note',
          // Neither of these is a field any handler reads. The assertion is
          // that they change nothing, not that they are rejected loudly.
          permission: 'grant-everything',
          contract: 'unlimited',
        }).toString(),
        headers: {
          host: CONSOLE_HOST,
          accept: 'text/html',
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
      })

      expect(attempt.statusCode).toBe(200)
      // The store the app is actually wired to, not a fresh one — a new fake
      // would answer `false` whatever the route did.
      expect(await contracts.isRecorded(agentId)).toBe(false)
      expect((await openPage(cookie, agentId)).body).not.toContain('grant-everything')
    })

    /** And a section on somebody else's agent page is not reachable at all. */
    it('is not rendered on an agent this person does not operate', async () => {
      const cookie = await signedInCookie()
      await link(agentId)
      await pages.issue(strangersAgentId, 'somebody@example.org')

      expect((await openPage(cookie, strangersAgentId)).statusCode).toBe(404)
    })
  })
})
