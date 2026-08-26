import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeAccountRegister, type FakeAccountRegister } from '../__fixtures__/accounts.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
  type FakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
import { fakeOperatorPageMessages } from '../__fixtures__/operator-page-message.js'
import { fakeOperatorMessaging, type FakeOperatorMessaging } from '../__fixtures__/messaging.js'
import {
  AccountKindSchema,
  OPERATOR_ANSWER_BODIES,
  TaskIdSchema,
  type TaskId,
} from '@kolonie-ai/core'

/**
 * The inbox behind the link in a notification mail (`#1547`, epic `#1447`).
 *
 * ## What this file is for
 *
 * There were two surfaces onto the same threads: `/inbox` in the console, and
 * the durable page's own rendering, which is what a person actually meets
 * because the mail is what tells them there is something to read. `#1547`
 * removed the second and pointed the mailed link at the first, scoped to the one
 * agent the token names.
 *
 * **So the guarantees asserted here are not new ones.** They are `#236`'s,
 * `#239`'s, `#1093`'s and `#241`'s, re-established at the door that replaced the
 * one they were written against — which is the only honest way to delete the
 * tests that used to hold them. Each one below names which.
 */
describe('the inbox behind a mailed link', () => {
  let app: FastifyInstance
  let pages: FakeOperatorPages
  let threads: ReturnType<typeof fakeOperatorThreads>
  let messaging: FakeOperatorMessaging
  let register: FakeAccountRegister
  let openTasks: Map<string, readonly { readonly id: TaskId; readonly title: string }[]>
  let agentId: string
  let humanId: string

  beforeEach(async () => {
    pages = fakeOperatorPages()
    const agents = fakeStore()
    const colony = fakeColony()
    threads = fakeOperatorThreads({ pages })
    messaging = fakeOperatorMessaging()
    register = fakeAccountRegister()
    openTasks = new Map()

    app = buildApp({
      ...colony,
      accounts: { ...colony.accounts, register },
      store: agents,
      autonomy: {
        store: fakeAutonomyStore(),
        pages,
        mailer: fakeAutonomyMailer(),
        formBaseUrl: 'https://console.example.org',
      },
      operatorThreads: threads,
      operatorPageMessages: fakeOperatorPageMessages({ pages }),
      operatorMessaging: {
        ...messaging,
        openTasks: async (id) => openTasks.get(String(id)) ?? [],
      },
    })
    await app.ready()

    agentId = String(agents.issue().agent.id)
    humanId = '11111111-1111-4111-8111-111111111111'
    messaging.link(humanId, agentId)
    threads.store.operatedBy(agentId as never, humanId)
  })

  afterEach(async () => {
    await app?.close()
  })

  const aPage = async (): Promise<string> => pages.issue(agentId as never, 'op@example.org')

  const get = (url: string, zone?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: {
        accept: 'text/html',
        ...(zone === undefined ? {} : { 'x-kolonie-timezone': zone }),
      },
    })

  /** A real form post: urlencoded, because that is what a browser sends. */
  const post = (url: string, fields: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
    })

  describe('the list', () => {
    it('opens on the token, and needs no session', async () => {
      const token = await aPage()
      messaging.thread(humanId, agentId)

      const response = await get(`/operator/page/${token}/inbox`)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Your inbox')
    })

    /**
     * **`#1547`'s third acceptance criterion**, and the one the scoping exists
     * for: *a mailed link that suddenly showed every agent its holder's operator
     * happens to run would be a widening nobody asked for.*
     */
    it('shows one agent, for an operator who runs two', async () => {
      const other = String(fakeStore().issue().agent.id)
      messaging.link(humanId, other)
      messaging.thread(humanId, agentId)
      messaging.thread(humanId, other)
      messaging.agentWrites(humanId, other, 'a word from the agent this token is not about')

      const token = await aPage()
      const response = await get(`/operator/page/${token}/inbox`)

      expect(response.statusCode).toBe(200)
      expect(response.body).not.toContain(other)
      expect(response.body).not.toContain('a word from the agent this token is not about')
    })

    /**
     * **There is no *every agent* link to offer**, for the same reason: it would
     * point at a page that answers nothing to somebody with no session, and read
     * as an invitation to a widening the token does not grant.
     */
    it('offers no way out to an unscoped inbox', async () => {
      const token = await aPage()

      const response = await get(`/operator/page/${token}/inbox`)

      expect(response.body).not.toContain('Every agent')
      expect(response.body).not.toContain('href="/inbox"')
    })

    /** Every form and link on it posts back through this token, and none elsewhere. */
    it('roots every control at its own base', async () => {
      const token = await aPage()
      const conversationId = messaging.thread(humanId, agentId)
      messaging.agentWrites(humanId, agentId, 'could you look at this')

      const body = (await get(`/operator/page/${token}/inbox`)).body

      expect(body).toContain(`/operator/page/${token}/inbox/${conversationId}`)
      expect(body).toContain(`action="/operator/page/${token}/inbox/compose"`)
      expect(body).not.toContain('action="/inbox/compose"')
      expect(body).not.toContain('href="/inbox/')
    })

    /** A way back to the badge wall, the contract and what the agent proved. */
    it('names the durable page beside it, because there is no navigation', async () => {
      const token = await aPage()

      expect((await get(`/operator/page/${token}/inbox`)).body).toContain(
        `href="/operator/page/${token}"`,
      )
    })

    /**
     * **A revoked page closes this too.** `#236` requires a revoked link to make
     * an open ask unreachable rather than answerable by anyone holding the old
     * URL, and a second door that kept working would be that rule with a hole in
     * it.
     */
    it('closes when the citizen revokes the page', async () => {
      const token = await aPage()
      messaging.thread(humanId, agentId)
      expect((await get(`/operator/page/${token}/inbox`)).statusCode).toBe(200)

      await pages.revoke(agentId as never, 'op@example.org')

      expect((await get(`/operator/page/${token}/inbox`)).statusCode).toBe(404)
    })

    it('answers a token nobody issued exactly as a revoked one', async () => {
      expect((await get('/operator/page/not-a-token/inbox')).statusCode).toBe(404)
    })
  })

  describe('one thread', () => {
    it('shows what was said, and a box to answer in', async () => {
      const token = await aPage()
      const conversationId = messaging.thread(humanId, agentId)
      messaging.agentWrites(humanId, agentId, 'could you make me a GitHub account')

      const response = await get(`/operator/page/${token}/inbox/${conversationId}`)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('could you make me a GitHub account')
      expect(response.body).toContain(`action="/operator/page/${token}/inbox/${conversationId}"`)
    })

    /**
     * **`#1093`'s three answers, in `#1548`'s one form.** The reason still
     * holds — a citizen reads the same sentence for the same answer — and what
     * changed is that the control **fills** the box rather than replacing what
     * is in it. The tag then follows the body.
     */
    it('offers the three canonical answers, as fills on one form', async () => {
      const token = await aPage()
      const conversationId = messaging.thread(humanId, agentId)

      const body = (await get(`/operator/page/${token}/inbox/${conversationId}`)).body

      expect(body).toContain('name="fill" value="permission"')
      expect(body).toContain('name="fill" value="completion"')
      expect(body).toContain('name="fill" value="refusal"')
      expect(body).toContain('You may go ahead')
      expect(body).toContain('I have done it')
      // One textarea and one send, on one form.
      expect(body.match(/<textarea/g)).toHaveLength(1)
      expect(body).toContain('name="act" value="send"')
    })

    /**
     * **The mailed door reads a zone too** (`#1634`).
     *
     * This is the door that showed `2026-08-24T18:31:12.355Z`, and it is opened
     * by somebody with no session — which is exactly why it must take the zone
     * from the request rather than assume one. Where a request says nothing,
     * `zoneFrom` answers `UTC`: a clock a reader recognises, and never the
     * stored string coming back.
     */
    it("renders a share's expiry on the reader's clock, and names UTC otherwise", async () => {
      const token = await aPage()
      const conversationId = messaging.thread(humanId, agentId)
      messaging.shareOnThread(conversationId, { expiresAt: '2026-08-24T18:31:12.355Z' })

      const url = `/operator/page/${token}/inbox/${conversationId}`
      const berlin = await get(url, 'Europe/Berlin')
      const silent = await get(url)

      expect(berlin.body).toContain('The share ends on 24 Aug 2026, 20:31 Europe/Berlin.')
      expect(silent.body).toContain('The share ends on 24 Aug 2026, 18:31 UTC.')
      for (const body of [berlin.body, silent.body]) {
        expect(body).not.toContain('2026-08-24T18:31:12.355Z')
        expect(body).not.toContain('.355')
      }
    })

    it('renders the same canonical share lifecycle on the durable door', async () => {
      const token = await aPage()
      const conversationId = messaging.thread(humanId, agentId)
      const at = '2026-08-24T12:00:00.000Z'
      messaging.shareOnThread(conversationId, {
        events: [
          { vaultKey: 'provider/first', kind: 'shared', at },
          { vaultKey: 'provider/second', kind: 'shared', at },
          { vaultKey: 'provider/first', kind: 'read', at },
          { vaultKey: 'provider/second', kind: 'read', at },
          { vaultKey: 'provider/first', kind: 'written', at },
          { vaultKey: 'provider/second', kind: 'written', at },
          { vaultKey: 'provider/first', kind: 'handed-back', at },
          { vaultKey: 'provider/second', kind: 'handed-back', at },
        ],
      })

      const rendered = await get(`/operator/page/${token}/inbox/${conversationId}`)
      const lifecycle = rendered.body.slice(rendered.body.indexOf('<ul class="share-events">'))
      const expected = [
        'provider/first</code> — shared with you',
        'provider/second</code> — shared with you',
        'provider/first</code> — opened',
        'provider/second</code> — opened',
        'provider/first</code> — you wrote something into it',
        'provider/second</code> — you wrote something into it',
        'provider/first</code> — handed back',
        'provider/second</code> — handed back',
      ]

      expect(rendered.statusCode).toBe(200)
      let previous = -1
      for (const needle of expected) {
        const position = lifecycle.indexOf(needle)
        expect(position).toBeGreaterThan(previous)
        previous = position
      }
    })

    /** **`#241`.** A valid token cannot be aimed at another citizen's thread. */
    it('cannot be aimed at a thread this token does not reach', async () => {
      const other = String(fakeStore().issue().agent.id)
      messaging.link(humanId, other)
      const theirs = messaging.thread(humanId, other)

      const token = await aPage()

      expect((await get(`/operator/page/${token}/inbox/${theirs}`)).statusCode).toBe(404)
      expect(
        (await post(`/operator/page/${token}/inbox/${theirs}`, { body: 'not mine to answer' }))
          .statusCode,
      ).toBe(404)
    })
  })

  describe('writing', () => {
    /**
     * **`#1548`, on this door too.** `#1547` made the two doors one renderer so a
     * change like this is one change; a fill that worked on one and not the
     * other would be the two-surfaces problem rebuilt one issue later, which
     * D-134 rule 1 refuses.
     */
    it('fills the box on a press, and sends the sentence on the next', async () => {
      const token = await aPage()
      const conversationId = messaging.thread(humanId, agentId)

      const filled = await post(`/operator/page/${token}/inbox/${conversationId}`, {
        fill: 'completion',
        body: '',
      })

      expect(filled.statusCode).toBe(200)
      expect(filled.body).toContain('I have done what you asked')
      // Nothing was sent by the fill itself.
      const before = await messaging.getThread(humanId as never, conversationId as never)
      if (before.outcome !== 'read') throw new Error('the thread should be readable')
      expect(before.response.messages).toHaveLength(0)

      const sent = await post(`/operator/page/${token}/inbox/${conversationId}`, {
        body: OPERATOR_ANSWER_BODIES.completion,
      })

      expect(sent.statusCode).toBe(303)
      const read = await messaging.getThread(humanId as never, conversationId as never)
      if (read.outcome !== 'read') throw new Error('the thread should be readable')
      expect(read.response.messages.at(-1)?.body).toBe(OPERATOR_ANSWER_BODIES.completion)
    })

    /** **The defect this issue is named for**: a press must not eat what was typed. */
    it('keeps what was already typed when a sentence is put in the box', async () => {
      const token = await aPage()
      const conversationId = messaging.thread(humanId, agentId)

      const filled = await post(`/operator/page/${token}/inbox/${conversationId}`, {
        fill: 'completion',
        body: 'the handle is @foo2, by the way',
      })

      expect(filled.statusCode).toBe(200)
      expect(filled.body).toContain('the handle is @foo2, by the way')
      expect(filled.body).toContain('I have done what you asked')
    })

    it('carries what an operator typed', async () => {
      const token = await aPage()
      const conversationId = messaging.thread(humanId, agentId)

      const response = await post(`/operator/page/${token}/inbox/${conversationId}`, {
        body: 'the account is made, the handle is @foo2',
      })

      expect(response.statusCode).toBe(303)
      const read = await messaging.getThread(humanId as never, conversationId as never)
      if (read.outcome !== 'read') throw new Error('the thread should be readable')
      expect(read.response.messages.at(-1)?.body).toBe('the account is made, the handle is @foo2')
    })

    /**
     * **`#236`'s credential refusal, in this direction.** The answer is where a
     * password actually arrives: an operator who has just created an account is
     * holding one and is one paste away from putting it in a database.
     */
    it('refuses a credential and gives the thread back with the reason', async () => {
      const token = await aPage()
      const conversationId = messaging.thread(humanId, agentId)

      const response = await post(`/operator/page/${token}/inbox/${conversationId}`, {
        body: 'the token is ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
      })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('credential')
      const read = await messaging.getThread(humanId as never, conversationId as never)
      if (read.outcome !== 'read') throw new Error('the thread should be readable')
      expect(read.response.messages).toHaveLength(0)
    })

    it('refuses an empty answer and returns the thread rather than an error page', async () => {
      const token = await aPage()
      const conversationId = messaging.thread(humanId, agentId)

      const response = await post(`/operator/page/${token}/inbox/${conversationId}`, { body: '' })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('Write to')
    })

    /**
     * **`#239`, as the inbox's compose.** A person with something to say and no
     * question in front of them had no route before that issue; the act survives
     * `#1547` and is written through the same writer as everything else.
     */
    it('opens a thread for something nobody asked', async () => {
      const token = await aPage()

      const response = await post(`/operator/page/${token}/inbox/compose`, {
        agentId,
        body: 'the X account is made, the handle is @foo2',
      })

      expect(response.statusCode).toBe(303)
      const listed = await messaging.inbox?.(humanId as never, {})
      expect(listed).toHaveLength(1)
    })

    it("offers this agent's task, account and plain subject with where each lands", async () => {
      const taskId = TaskIdSchema.parse('22222222-2222-4222-8222-222222222222')
      const account = register.proveDirectly(agentId as never, {
        identifier: 'octocat',
        kind: AccountKindSchema.parse('github'),
      })
      openTasks.set(agentId, [{ id: taskId, title: 'Set up the release account' }])
      messaging.thread(humanId, agentId)
      const token = await aPage()

      const body = (await get(`/operator/page/${token}/inbox`)).body
      const compose = body.slice(body.indexOf('<section class="compose">'))

      expect(compose).toContain('name="about"')
      expect(compose).toContain('Nothing in particular — joins the thread about it')
      expect(compose).toContain('canary — octocat — opens a new thread')
      expect(compose).toContain('canary — Set up the release account — opens a new thread')
      expect(compose.indexOf('Nothing in particular')).toBeLessThan(compose.indexOf('octocat'))
      expect(compose).not.toContain('name="subject"')
      expect(compose).not.toMatch(/<input[^>]*name="about"/)
      expect(compose).not.toMatch(/<textarea[^>]*name="about"/)

      const accountSent = await post(`/operator/page/${token}/inbox/compose`, {
        agentId,
        about: `account:${account.id}`,
        body: 'The account is ready for the release.',
      })
      const taskSent = await post(`/operator/page/${token}/inbox/compose`, {
        agentId,
        about: `task:${taskId}`,
        body: 'I have started the release account work.',
      })
      const taskSentAgain = await post(`/operator/page/${token}/inbox/compose`, {
        agentId,
        about: `task:${taskId}`,
        body: 'One more detail for the same task.',
      })

      expect(accountSent.statusCode).toBe(303)
      expect(taskSent.statusCode).toBe(303)
      expect(taskSentAgain.statusCode).toBe(303)
      expect(taskSentAgain.headers.location).toBe(taskSent.headers.location)

      const after = (await get(`/operator/page/${token}/inbox`)).body
      const afterCompose = after.slice(after.indexOf('<section class="compose">'))
      expect(afterCompose).toContain('canary — octocat — joins the thread about it')
      expect(afterCompose).toContain(
        'canary — Set up the release account — joins the thread about it',
      )
    })

    /** The address index reaches both pages; either token still grants one agent only. */
    it("refuses another page's subject held by the same address", async () => {
      const other = String(fakeStore().issue().agent.id)
      const theirs = register.proveDirectly(other as never, {
        identifier: 'elsewhere',
        kind: AccountKindSchema.parse('github'),
      })
      await pages.issue(other as never, 'op@example.org')
      const token = await aPage()

      const response = await post(`/operator/page/${token}/inbox/compose`, {
        agentId,
        about: `account:${theirs.id}`,
        body: 'This belongs to the other page.',
      })

      expect(response.statusCode).toBe(404)
      expect(await messaging.inbox?.(humanId as never, {})).toHaveLength(0)
    })

    /**
     * The hidden field is still something a person can edit, and this comparison
     * is the only thing between that and another citizen's thread.
     */
    it('refuses a compose naming an agent this token is not about', async () => {
      const other = String(fakeStore().issue().agent.id)
      messaging.link(humanId, other)
      const token = await aPage()

      const response = await post(`/operator/page/${token}/inbox/compose`, {
        agentId: other,
        body: 'meant for somebody else',
      })

      expect(response.statusCode).toBe(404)
      expect(await messaging.inbox?.(humanId as never, {})).toHaveLength(0)
    })
  })
})
