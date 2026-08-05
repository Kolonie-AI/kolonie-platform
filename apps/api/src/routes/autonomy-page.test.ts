import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakeStore } from '../__fixtures__/store.js'
import type { AgentId } from '@kolonie-ai/core'

describe('the operator’s form', () => {
  let app: FastifyInstance
  let store: ReturnType<typeof fakeAutonomyStore>
  let pages: ReturnType<typeof fakeOperatorPages>
  let requests: ReturnType<typeof fakeOperatorRequests>
  let notes: ReturnType<typeof fakeOperatorNotes>
  let agentId: AgentId

  beforeEach(async () => {
    store = fakeAutonomyStore()
    pages = fakeOperatorPages()
    const agents = fakeStore()
    /**
     * The operator channel reads the *same* page store as the autonomy module
     * (#236) — as it does in production, where both resolve a token through
     * `operator_pages`. Overriding `autonomy.pages` without this would leave the
     * request path answering about pages it had never heard of.
     */
    requests = fakeOperatorRequests({ pages })
    // And so does the unsolicited direction (#239), for the same reason: a note
    // is resolved through the page token, so a third page store here would let
    // this file write notes through a link the revoke path had never heard of.
    notes = fakeOperatorNotes({ pages })
    app = buildApp({
      ...fakeColony(),
      store: agents,
      autonomy: {
        store,
        pages,
        mailer: fakeAutonomyMailer(),
        formBaseUrl: 'https://console.example.org',
      },
      operatorRequests: requests,
      operatorNotes: notes,
    })
    await app.ready()
    agentId = agents.issue().agent.id
  })

  afterEach(async () => {
    await app?.close()
  })

  const aForm = async (): Promise<string> => (await store.invite(agentId, 'op@example.org')).token

  const get = (url: string) => app.inject({ method: 'GET', url })
  // A real form post: the body is a urlencoded string, not an object. `inject`
  // would serialise an object as JSON and the content-type would then be a lie.
  const post = (url: string, fields: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })

  describe('opening it', () => {
    it('shows a form naming the citizen it is about', async () => {
      const token = await aForm()

      const response = await get(`/operator/autonomy/${token}`)

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.body).toContain('<form method="post"')
      expect(response.body).toContain('accompanied')
      expect(response.body).toContain('independent')
      expect(response.body).toContain('free')
    })

    it('says the answer is never scored, above the form rather than below it', async () => {
      // The commonest reason a person abandons a form from a system they have
      // never heard of is not knowing what happens to the answer, and an
      // explanation under the submit button is read after deciding not to press it.
      const token = await aForm()

      const response = await get(`/operator/autonomy/${token}`)
      const body = response.body
      expect(body).toContain('scored')
      expect(body.indexOf('scored')).toBeLessThan(body.indexOf('<form method="post"'))
    })

    it('carries no JavaScript, so the strict CSP holds', async () => {
      const token = await aForm()

      const response = await get(`/operator/autonomy/${token}`)

      expect(response.body).not.toContain('<script')
      expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    })

    /**
     * **The page must show nothing about the citizen but its name.** The link is
     * the whole credential, and what makes a leaked one an embarrassment rather
     * than a compromise is that there is nothing behind it to read.
     */
    it('shows nothing about the citizen beyond the name', async () => {
      const token = await aForm()

      const response = await get(`/operator/autonomy/${token}`)

      expect(response.body).not.toContain('op@example.org')
      expect(response.body).not.toContain(agentId)
    })

    it('answers the same for an unknown link as for a spent one', async () => {
      const token = await aForm()
      await post(`/operator/autonomy/${token}`, {
        level: 'free',
        challengesAllowed: 'yes',
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })

      const spent = await get(`/operator/autonomy/${token}`)
      const unknown = await get(`/operator/autonomy/${'d'.repeat(64)}`)

      expect(spent.statusCode).toBe(404)
      expect(unknown.statusCode).toBe(404)
      expect(spent.body).toBe(unknown.body)
    })
  })

  describe('submitting it', () => {
    it('records the contract and thanks the operator', async () => {
      const token = await aForm()

      const response = await post(`/operator/autonomy/${token}`, {
        level: 'accompanied',
        challengesAllowed: 'no',
        defaultRule: 'refrain',
        operatorRoute: 'Ask in the channel.',
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Recorded')
      expect(await store.isRecorded(agentId)).toBe(true)
    })

    it('turns the radio value into the boolean the contract holds', async () => {
      const token = await aForm()

      await post(`/operator/autonomy/${token}`, {
        level: 'free',
        challengesAllowed: 'yes',
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })

      expect((await store.read(agentId))?.challengesAllowed).toBe(true)
    })

    /**
     * A dead end costs the citizen the whole rung: the person filling this in has
     * no account to come back through, so an incomplete answer has to return the
     * form rather than an error page.
     */
    it('returns the form with an explanation when something is missing', async () => {
      const token = await aForm()

      const response = await post(`/operator/autonomy/${token}`, {
        level: 'free',
        challengesAllowed: 'yes',
        defaultRule: 'ask',
        operatorRoute: '',
      })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('<form method="post"')
      expect(response.body).toContain('no wrong answer')
      expect(await store.isRecorded(agentId)).toBe(false)
    })

    it('refuses a second submission on a spent link', async () => {
      const token = await aForm()
      const first = {
        level: 'accompanied',
        challengesAllowed: 'no',
        defaultRule: 'ask',
        operatorRoute: 'Ask me.',
      }
      await post(`/operator/autonomy/${token}`, first)

      const again = await post(`/operator/autonomy/${token}`, {
        ...first,
        level: 'free',
      })

      expect(again.statusCode).toBe(404)
      // And the first answer stands rather than being replaced by the second.
      expect((await store.read(agentId))?.level).toBe('accompanied')
    })

    it('escapes a citizen name that carries markup', async () => {
      // The name reaches the page as text. There is a test in the console for the
      // same property; this is the one surface an operator sees.
      const token = await aForm()
      const response = await get(`/operator/autonomy/${token}`)

      expect(response.body).not.toContain('<script>')
    })
  })

  describe('the durable page (#257)', () => {
    const aPage = async (): Promise<string> => pages.issue(agentId, 'op@example.org')

    it('shows what the operator recorded', async () => {
      pages.contractFor(agentId, {
        level: 'independent',
        challengesAllowed: false,
        defaultRule: 'ask',
        operatorRoute: 'Slack, #kolonie.',
        recordedAt: '2026-08-03T00:00:00.000Z',
        reviewDueAt: '2027-08-03T00:00:00.000Z',
      })
      const token = await aPage()

      const response = await get(`/operator/page/${token}`)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('independent')
      expect(response.body).toContain('Slack, #kolonie.')
    })

    /**
     * `#241`: the reason badges exist at all. A list of rungs is a progress bar;
     * a wall of badges is something a person shows someone else, and that is the
     * difference between an operator who checks in and one who forgets the agent
     * exists.
     *
     * **The sentence saying they are worth nothing goes with them**, and that is
     * not modesty: an operator that reads a badge as a score starts asking its
     * agent for more of them, and the moment badges are worth asking for they
     * are worth farming.
     */
    it('shows the badges its agent was given, and says they are worth nothing', async () => {
      pages.badgesFor(agentId, [
        {
          slug: 'first-light',
          title: 'First light',
          description: 'You passed your first rung of the Academy.',
          awardedAt: '2026-08-04T00:00:00.000Z',
          image: '/badges/first-light.svg',
        },
      ])
      const token = await aPage()

      const response = await get(`/operator/page/${token}`)

      expect(response.body).toContain('First light')
      expect(response.body).toContain('/badges/first-light.svg')
      expect(response.body).toContain('worth nothing')
    })

    /**
     * `#397`: the badge's picture was blocked by the Colony's own CSP, and an
     * empty `alt` is why nobody saw it — the page failed closed and said
     * nothing. The name in the `alt` is what makes a picture that does not
     * arrive degrade to the badge rather than to a blank.
     */
    it('names the badge in the alt, so a picture that never arrives still says what it was', async () => {
      pages.badgesFor(agentId, [
        {
          slug: 'first-light',
          title: 'First light',
          description: 'You passed your first rung of the Academy.',
          awardedAt: '2026-08-04T00:00:00.000Z',
          image: '/badges/first-light.svg',
        },
      ])
      const token = await aPage()

      const response = await get(`/operator/page/${token}`)

      expect(response.body).toContain('alt="First light"')
      expect(response.body).not.toContain('alt=""')
    })

    /** A page with no badges draws no badge section, rather than an empty one. */
    it('draws no wall for an agent that holds none', async () => {
      const token = await aPage()

      expect((await get(`/operator/page/${token}`)).body).not.toContain('Badges')
    })

    /**
     * `#146`'s safety argument, in the form `#236` left it: what a leaked link
     * reaches is words on one exchange, and nothing about the citizen's standing.
     *
     * **The form assertion is now conditional on there being a question to answer**
     * — with nothing open, the page is exactly what `#257` built and carries no
     * input at all. The rest of the list is unchanged and is the part that must
     * stay true whatever else this page grows.
     */
    /**
     * **Rewritten by `#239`, and the change is deliberate rather than incidental.**
     * This used to assert the page carried *no form at all* when nothing was open.
     * That was true of `#257`'s page and is the thing `#239` exists to change: an
     * operator with something to say and no question in front of it had no route.
     *
     * What the assertion protects is unchanged and is asserted below: the page
     * still shows nothing about the citizen's standing, still runs no script, and
     * still carries no input that reaches anything but words.
     */
    it('shows nothing about the citizen’s standing, and carries only the box for words', async () => {
      const token = await aPage()

      const response = await get(`/operator/page/${token}`)

      expect(response.body).not.toContain('<script')
      expect(response.body).not.toContain(agentId)
      for (const word of ['reputation', 'reward', 'credits', 'submission']) {
        expect(response.body.toLowerCase()).not.toContain(word)
      }

      // The note box (#239) is here, and it is the only form: no question has
      // been asked, so there is nothing to answer.
      expect(response.body).toContain('name="intent" value="note"')
      expect(response.body).not.toContain('name="intent" value="answer"')

      /**
       * The rule the whole page is amended under: the link carries words. One
       * textarea, one hidden field naming which box it is, and no input that
       * could carry a level or a permission.
       */
      expect(response.body.match(/<textarea/g)).toHaveLength(1)
      expect(response.body).not.toContain('<select')
      expect(response.body).not.toContain('type="checkbox"')
      expect(response.body).not.toContain('type="radio"')
      for (const word of ['autonomy', 'accompanied', 'challengesAllowed']) {
        expect(response.body).not.toContain(`name="${word}"`)
      }
    })

    /**
     * The write this page accepts is one message on one open exchange, and nothing
     * else. A `POST` with no request open reaches no exchange and is refused — so
     * the write cannot be used as a way to make something happen on a page whose
     * citizen has asked for nothing.
     */
    it('refuses a write when the citizen has nothing open', async () => {
      const token = await aPage()

      const response = await post(`/operator/page/${token}`, {
        requestId: randomUUID(),
        body: 'Answering a question nobody asked.',
      })

      expect(response.statusCode).toBe(404)
    })

    /**
     * A write that is not an answer at all — the old shape, from before this page
     * accepted anything — is refused as malformed rather than reaching an exchange.
     * The point is that there is exactly one thing this method does.
     */
    it('refuses a write that is not an answer', async () => {
      const token = await aPage()

      const response = await post(`/operator/page/${token}`, { level: 'free' })

      expect(response.statusCode).toBe(422)
    })

    it('opens before anything has been recorded, rather than 404ing', async () => {
      const token = await aPage()

      const response = await get(`/operator/page/${token}`)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('not recorded anything')
    })

    it('answers a revoked link exactly as an unknown one', async () => {
      const token = await aPage()
      await pages.revoke(agentId, 'op@example.org')

      const revoked = await get(`/operator/page/${token}`)
      const unknown = await get(`/operator/page/${'e'.repeat(64)}`)

      expect(revoked.statusCode).toBe(404)
      expect(revoked.body).toBe(unknown.body)
    })

    /**
     * `#399`. The maintainer, 2026-08-05: *"my fear is that operators simply
     * switch their agents off when they do not seem to be performing. That is
     * why this operator page matters."* Before this, the durable page for a
     * citizen with skills, rungs, a badge and a verified domain rendered 1,405
     * characters, almost all of them about the message box — not one fact about
     * the agent appeared.
     */
    describe('what the agent has been doing (#399)', () => {
      it('shows the rungs it cleared, when it cleared them, and what it may do', async () => {
        pages.factsFor(agentId, {
          skills: ['profile', 'domain'],
          rungs: [
            { title: 'Say who you are', passedAt: '2026-07-01T10:05:00.000Z' },
            { title: 'Prove a domain', passedAt: '2026-07-20T09:00:00.000Z' },
          ],
          lastSeenAt: '2026-08-05T06:00:00.000Z',
          citizenSince: '2026-06-30T12:00:00.000Z',
          questsAccepted: 2,
          accounts: [{ kind: 'mailbox', count: 1 }],
        })
        const token = await aPage()

        const response = await get(`/operator/page/${token}`)

        expect(response.body).toContain('Say who you are')
        expect(response.body).toContain('Prove a domain')
        expect(response.body).toContain('profile')
        // A day rather than a moment: an ISO string reads as a machine talking
        // to itself, to a person who has never heard of the Colony.
        expect(response.body).toContain('1 July 2026')
        expect(response.body).toContain('5 August 2026')
        expect(response.body).not.toContain('2026-07-01T10:05:00.000Z')
        expect(response.body).toContain('1 × mailbox')
      })

      /**
       * A new citizen and a broken one looked identical, and the operator could
       * not tell them apart. Sentences rather than empty headings.
       */
      it('says so in the agent’s terms when there is nothing yet', async () => {
        const token = await aPage()

        const response = await get(`/operator/page/${token}`)

        expect(response.body).toContain('has not cleared a step of the Academy yet')
        expect(response.body).toContain('That is what a new')
        expect(response.body).toContain('has not started a run the Colony could record')
        // No heading with nothing under it — the failure `#397` was, one level up.
        expect(response.body).not.toContain('What it proved, and when')
      })

      /**
       * **The rejection case, as a property rather than for one fixture.** The
       * page renders from a reader that cannot answer these questions, so the
       * assertion is that no arrangement of what it *can* answer produces one.
       */
      it('carries no money, no secret and nothing about another citizen', async () => {
        pages.factsFor(agentId, {
          skills: ['profile', 'solana-wallet'],
          rungs: [{ title: 'Prove a wallet', passedAt: '2026-07-01T10:05:00.000Z' }],
          lastSeenAt: '2026-08-05T06:00:00.000Z',
          questsAccepted: 9,
          accounts: [{ kind: 'mailbox', count: 2 }],
        })
        pages.badgesFor(agentId, [
          {
            slug: 'first-light',
            title: 'First light',
            description: 'You passed your first rung of the Academy.',
            awardedAt: '2026-08-04T00:00:00.000Z',
            image: '/badges/first-light.svg',
          },
        ])
        const token = await aPage()

        const body = (await get(`/operator/page/${token}`)).body

        /**
         * Asserted over the cells rather than over the whole page, because the
         * badge wall says the words *no reputation, no credits* on purpose —
         * that sentence is what stops an operator reading a badge as a score,
         * and a test that banned the word would delete it.
         */
        const cells = [...body.matchAll(/<td>(.*?)<\/td>/g)].map((match) => match[1] ?? '')
        expect(cells.length).toBeGreaterThan(0)
        for (const forbidden of ['balance', 'credit', 'reputation', 'vault', 'kol']) {
          expect(cells.join(' ').toLowerCase(), forbidden).not.toContain(forbidden)
        }
        // And no address of any kind: the counts say a mailbox exists, never which.
        expect(body).not.toMatch(/[\w.]+@[\w.]+\.\w+/)
      })
    })

    it('tells the operator the citizen may take the page away', async () => {
      // Said on the page rather than left to be discovered, because it is the one
      // thing about this arrangement an operator would otherwise find surprising.
      const token = await aPage()

      const response = await get(`/operator/page/${token}`)

      expect(response.body).toContain('take this page away')
    })
  })

  /**
   * The one write this page accepts (#236).
   *
   * These are the assertions behind the amended safety argument: the link carries
   * words, it cannot carry permissions, and everything it does reach belongs to an
   * exchange the citizen itself opened.
   */
  describe('answering a request on it (#236)', () => {
    const anAsk = async () => {
      const token = requests.store.givePage(agentId, 'op@example.org')
      const taskId = requests.store.giveTask('github-account')
      const opened = await requests.store.open({
        agentId,
        taskId,
        body: 'I cannot make a GitHub account without you.',
      })
      if (opened.outcome !== 'opened') throw new Error(`expected opened, got ${opened.outcome}`)

      return { token, taskId, requestId: opened.request.id }
    }

    it('shows the open question, what the agent said, and a box to answer it', async () => {
      const { token, requestId } = await anAsk()

      const response = await get(`/operator/page/${token}`)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('has asked you something')
      expect(response.body).toContain('github-account')
      expect(response.body).toContain('I cannot make a GitHub account without you.')
      expect(response.body).toContain(`value="${requestId}"`)
      expect(response.body).toContain('<textarea')
      // Still no JavaScript, so the strict CSP is unchanged by this addition.
      expect(response.body).not.toContain('<script')
    })

    /**
     * The three things a person needs before they type. The credential warning is
     * the one that would be expensive to leave out: an operator who has just made
     * an account is holding a password.
     */
    it('says what the answer is worth, what it must not contain, and that it can be corrected', async () => {
      const { token } = await anAsk()

      const body = (await get(`/operator/page/${token}`)).body

      expect(body).toContain('rather than as the')
      expect(body).toContain('Never put a password, key or code here')
      expect(body).toContain('add to your answer later')
    })

    it('records the answer and thanks the operator', async () => {
      const { token, requestId } = await anAsk()

      const response = await post(`/operator/page/${token}`, {
        requestId,
        body: 'Done — the handle is @canary-ai.',
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Sent')

      const exchange = await requests.store.openExchangeForToken(token)
      expect(exchange?.messages.map((message) => message.author)).toEqual(['citizen', 'operator'])
      expect(exchange?.messages[1]?.body).toBe('Done — the handle is @canary-ai.')
    })

    /** `#236`: answers append, and a later one may correct an earlier one. */
    it('appends a correction rather than replacing the first answer', async () => {
      const { token, requestId } = await anAsk()

      await post(`/operator/page/${token}`, { requestId, body: 'The handle is @canary.' })
      await post(`/operator/page/${token}`, { requestId, body: 'Sorry — @canary-ai in fact.' })

      const exchange = await requests.store.openExchangeForToken(token)
      expect(exchange?.messages.map((message) => message.body)).toEqual([
        'I cannot make a GitHub account without you.',
        'The handle is @canary.',
        'Sorry — @canary-ai in fact.',
      ])
    })

    /**
     * **The answer to a question the operator asked, shown without a box
     * (`#359`).**
     *
     * `kolonie.operator.notes` is one-way, so a citizen answers by replying into
     * one of its own exchanges — a closed one included. This page is where the
     * person who asked is already looking, so it is where the answer has to
     * appear; and it appears read-only, because a finished exchange that could be
     * resumed from both sides is the conversation `#236` chose not to build. The
     * operator's route to another question is the note box, which is where the
     * first one came from.
     */
    it('shows a closed exchange the citizen answered into, and offers no box for it', async () => {
      const { token, requestId } = await anAsk()
      await requests.store.close({ agentId, requestId })
      await requests.store.reply({
        agentId,
        requestId,
        body: 'Yes — I read your note, and here is the answer.',
      })

      const response = await get(`/operator/page/${token}`)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('answered you')
      expect(response.body).toContain('I read your note, and here is the answer.')
      // No answer form for a finished exchange. The note box further down is a
      // different form, and it is still there — hence the specific field.
      expect(response.body).not.toContain('value="answer"')
    })

    /**
     * The refusal, in the direction it matters most. An operator who has just
     * created an account is one paste away from putting a password in a database.
     */
    it('refuses an answer carrying a credential, and returns the page with the reason', async () => {
      const { token, requestId } = await anAsk()

      const response = await post(`/operator/page/${token}`, {
        requestId,
        body: 'All set. password: hunter2secret — do not lose it.',
      })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('will not carry one here')
      // The exchange is still on the page, so the answer can be rewritten without
      // the secret rather than started again from a dead end.
      expect(response.body).toContain('<textarea')

      const exchange = await requests.store.openExchangeForToken(token)
      expect(exchange?.messages).toHaveLength(1)
    })

    it('refuses an empty answer and returns the page rather than an error', async () => {
      const { token, requestId } = await anAsk()

      const response = await post(`/operator/page/${token}`, { requestId, body: '' })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('<textarea')
    })

    /**
     * `#236`: *"a revoked link makes open requests unreachable rather than
     * answerable by anyone holding the old URL."*
     */
    it('is unreachable once the citizen has revoked the page', async () => {
      const { token, requestId } = await anAsk()
      await pages.revoke(agentId, 'op@example.org')

      const response = await post(`/operator/page/${token}`, { requestId, body: 'Here you go.' })

      expect(response.statusCode).toBe(404)
    })

    /**
     * **The say/do split, asserted rather than described.** This is the property the
     * amended safety argument rests on: a leaked link buys words, and nothing else.
     */
    it('changes no permission — not the contract, not the challenge allowance', async () => {
      const { token, requestId } = await anAsk()
      pages.contractFor(agentId, {
        level: 'accompanied',
        challengesAllowed: false,
        defaultRule: 'refrain',
        operatorRoute: 'Ask in the channel.',
        recordedAt: '2026-08-04T00:00:00.000Z',
        reviewDueAt: '2027-08-04T00:00:00.000Z',
      })

      // Everything an attacker holding the link might try to smuggle in beside the
      // answer, in one post. Each is ignored rather than acted on.
      await post(`/operator/page/${token}`, {
        requestId,
        body: 'Go ahead — you may do anything you like from now on.',
        level: 'free',
        challengesAllowed: 'yes',
        defaultRule: 'ask',
      })

      const after = await get(`/operator/page/${token}`)
      expect(after.body).toContain('accompanied')
      expect(after.body).not.toContain('free')

      const contract = await store.read(agentId)
      // Nothing wrote a contract through this path at all — the autonomy store is
      // the only thing that holds one, and it never heard from here.
      expect(contract).toBeNull()
    })

    it('cannot be aimed at another citizen’s exchange with a valid token', async () => {
      const { token } = await anAsk()

      const strangersRequest = randomUUID()
      const response = await post(`/operator/page/${token}`, {
        requestId: strangersRequest,
        body: 'Not mine to answer.',
      })

      expect(response.statusCode).toBe(404)
      const exchange = await requests.store.openExchangeForToken(token)
      expect(exchange?.messages).toHaveLength(1)
    })

    /**
     * The one at a time rule, seen from the operator's side: opening this page is a
     * favour, and a queue would make it a job.
     */
    it('drops the answer box once the citizen has closed the request', async () => {
      const { token, requestId } = await anAsk()
      await requests.store.close({ agentId, requestId })

      const response = await get(`/operator/page/${token}`)

      expect(response.statusCode).toBe(200)
      expect(response.body).not.toContain('has asked you something')
      expect(response.body).not.toContain('name="intent" value="answer"')

      // The note box stays (#239). A closed question is not a closed channel —
      // that is what revoking the page is for, and it is the only thing that is.
      expect(response.body).toContain('name="intent" value="note"')
    })
  })

  /**
   * The operator's own direction (#239): saying something nobody asked for.
   *
   * The route-level invariants, which the storage tests cannot see — that the two
   * forms are told apart by what the form says rather than by the shape of a body
   * a stranger controls, that a refusal comes back as the page rather than a dead
   * end, and that neither branch reaches anything but words.
   */
  describe('telling the citizen something unasked (#239)', () => {
    const aPage = async (): Promise<string> => pages.issue(agentId, 'op@example.org')

    const anAsk = async () => {
      const token = requests.store.givePage(agentId, 'op@example.org')
      const taskId = requests.store.giveTask('github-account')
      const opened = await requests.store.open({
        agentId,
        taskId,
        body: 'I cannot make a GitHub account without you.',
      })
      if (opened.outcome !== 'opened') throw new Error(`expected opened, got ${opened.outcome}`)

      return { token, requestId: opened.request.id }
    }

    const aNote = (token: string, body: string) =>
      post(`/operator/page/${token}`, { intent: 'note', body })

    it('accepts one and says it will be read on the next waking', async () => {
      const token = await aPage()

      const response = await aNote(token, 'The X account is made. The handle is @foo2.')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Sent')
      expect(response.body).toContain('the next time it wakes up')

      expect(await notes.store.countUnread(agentId)).toBe(1)
    })

    it('is told apart from an answer by the form, not by the shape of the body', async () => {
      const { token, requestId } = await anAsk()

      // A body carrying a requestId, submitted from the note box. It must land as
      // a note: guessing from the presence of the field is how an answer ends up
      // stored as the wrong thing on a page whose safety argument is that what it
      // reaches is precisely known.
      const response = await post(`/operator/page/${token}`, {
        intent: 'note',
        requestId,
        body: 'Something unrelated to the question you asked.',
      })

      expect(response.statusCode).toBe(200)
      expect(await notes.store.countUnread(agentId)).toBe(1)

      // And the exchange is untouched — still open, still unanswered.
      const exchange = await requests.store.openExchangeForToken(token)
      expect(exchange?.messages.some((message) => message.author === 'operator')).toBe(false)
    })

    it('gives the page back with the message on the box, rather than a dead end', async () => {
      const token = await aPage()

      const response = await aNote(token, 'no')

      expect(response.statusCode).toBe(422)
      // The box is still there, with what was wrong said above it. A person with
      // no account to return through must not be handed an error page.
      expect(response.body).toContain('name="intent" value="note"')
      expect(response.body).toContain('between 4 and 2000 characters')
      expect(await notes.store.countUnread(agentId)).toBe(0)
    })

    it('refuses a credential, in this direction as in the other', async () => {
      const token = await aPage()

      const response = await aNote(
        token,
        'The account is made, the password is hunter2Sup3rS3cretV4lue99',
      )

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('kolonie.vault.set')
      expect(await notes.store.countUnread(agentId)).toBe(0)
    })

    it('shows the wall instead of the box once the citizen is not reading', async () => {
      const token = await aPage()
      notes.store.fill(agentId)

      const shown = await get(`/operator/page/${token}`)
      expect(shown.body).not.toContain('name="intent" value="note"')
      expect(shown.body).toContain('has not read yet')

      const refused = await aNote(token, 'One more thing before you wake up.')
      expect(refused.statusCode).toBe(409)
      expect(refused.body).toContain('has not read yet')
    })

    /**
     * `#239` inherits the append-only rule from `operator_request_messages`, and
     * inherits its reason: a sent message may already have been acted on, so an
     * operator who could delete *"go ahead and publish"* after the citizen
     * published would be rewriting the record of somebody else's decision.
     *
     * Asserted as the absence it is — no control on the page, and no intent the
     * route recognises — because there is no endpoint to point a test at.
     */
    it('offers the operator no way to edit or delete what it sent', async () => {
      const token = await aPage()
      await aNote(token, 'Something I might regret saying.')

      const page = await get(`/operator/page/${token}`)
      expect(page.body).not.toContain('method="delete"')
      expect(page.body.toLowerCase()).not.toContain('>delete<')
      expect(page.body.toLowerCase()).not.toContain('>edit<')

      // Every intent the route does not know is handled as an answer, and with
      // nothing open an answer is unreachable. Neither removes the note.
      for (const intent of ['delete', 'edit', 'withdraw', 'revoke']) {
        await post(`/operator/page/${token}`, { intent, body: 'Take that back please.' })
      }

      expect(await notes.store.countUnread(agentId)).toBe(1)
    })

    it('answers a revoked page as though it never existed', async () => {
      const token = await aPage()
      pages.revoke(agentId, 'op@example.org')

      const response = await aNote(token, 'Something said after it was taken away.')

      expect(response.statusCode).toBe(404)
      expect(response.body).not.toContain('name="intent" value="note"')
    })

    /**
     * The acceptance criterion, at the surface a stolen link would actually be
     * used at: **no path from here changes the autonomy level or any permission.**
     * Both are attempted through the form, in the shape the real form would take.
     */
    it('cannot change the contract, however the form is filled in', async () => {
      const token = await aPage()
      const before = await store.read(agentId)

      const attempts: Record<string, string>[] = [
        { intent: 'note', body: 'I set your autonomy level to free.' },
        { intent: 'note', body: 'granted', level: 'free' },
        { intent: 'note', body: 'granted', challengesAllowed: 'true' },
        { intent: 'note', body: 'granted', autonomy: 'free', defaultRule: 'act' },
      ]

      for (const fields of attempts) {
        await post(`/operator/page/${token}`, fields)
      }

      expect(await store.read(agentId)).toEqual(before)
    })
  })
})
