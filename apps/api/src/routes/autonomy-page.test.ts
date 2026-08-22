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
import { fakeOperatorPageMessages } from '../__fixtures__/operator-page-message.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
import { fakeStore } from '../__fixtures__/store.js'
import type { AgentId } from '@kolonie-ai/core'

describe('the operator’s form', () => {
  let app: FastifyInstance
  let store: ReturnType<typeof fakeAutonomyStore>
  let pages: ReturnType<typeof fakeOperatorPages>
  let requests: ReturnType<typeof fakeOperatorThreads>
  let notes: ReturnType<typeof fakeOperatorPageMessages>
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
    requests = fakeOperatorThreads({ pages })
    // And so does the unsolicited direction (#239), for the same reason: a note
    // is resolved through the page token, so a third page store here would let
    // this file write notes through a link the revoke path had never heard of.
    notes = fakeOperatorPageMessages({ pages })
    app = buildApp({
      ...fakeColony(),
      store: agents,
      autonomy: {
        store,
        pages,
        mailer: fakeAutonomyMailer(),
        formBaseUrl: 'https://console.example.org',
      },
      operatorThreads: requests,
      operatorPageMessages: notes,
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
    /**
     * **The operator's own address is the one exception, and it arrived with
     * `#484`.** This used to assert `op@example.org` was absent, as a proxy for
     * *nothing about the invitation leaks*. That proxy stopped being right when
     * the route began prefilling the route field: the address belongs to the
     * **operator**, who is the person reading the page and the person it was
     * mailed to. Showing somebody their own address is not a disclosure.
     *
     * What the test was actually protecting — that the page says nothing about
     * the *citizen* beyond its name — is unchanged and is what it now asserts.
     */
    it('shows nothing about the citizen beyond the name', async () => {
      const token = await aForm()

      const response = await get(`/operator/autonomy/${token}`)

      expect(response.body).not.toContain(agentId)
      // The operator's own address, prefilled into their own field (`#484`).
      expect(response.body).toContain('value="op@example.org"')
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

    /**
     * `#1265`: the thank-you page names the console, not the agent.
     *
     * An operator who changes their mind was told to ask the agent for a fresh
     * form. The revise form already lives at `/agents/:agentId/autonomy`; this
     * is the pointer that was missing, and it is words rather than a permission
     * (D-081).
     */
    it('points at the console Autonomy page rather than asking the agent for a form', async () => {
      const token = await aForm()

      const response = await post(`/operator/autonomy/${token}`, {
        level: 'accompanied',
        challengesAllowed: 'no',
        defaultRule: 'refrain',
        operatorRoute: 'Ask in the channel.',
      })

      expect(response.body).toContain(`href="/agents/${agentId}/autonomy"`)
      expect(response.body).toContain('kolonie.operator.link')
      expect(response.body).not.toContain('ask your agent to send a new form')
      expect(response.body).not.toContain('fresh form')
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

    it('stores the web-server toggle as a named capability', async () => {
      const token = await aForm()

      await post(`/operator/autonomy/${token}`, {
        level: 'free',
        challengesAllowed: 'no',
        webServer: 'granted',
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })

      expect((await store.read(agentId))?.capabilities).toEqual(['web-server'])
    })

    it('stores an unticked web-server capability as not granted', async () => {
      const token = await aForm()

      await post(`/operator/autonomy/${token}`, {
        level: 'free',
        challengesAllowed: 'no',
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })

      expect((await store.read(agentId))?.capabilities).toEqual([])
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

  /**
   * One form, several agents (`#514`, variant B).
   *
   * The operator ticks; nothing is inherited. What the page must get right is
   * that the ids it posts are a **request** — the store decides which of them
   * this form may cover, and an id it may not is dropped rather than honoured.
   */
  describe('answering for several agents at once', () => {
    const SIBLING = '55555555-5555-4555-8555-555555555555' as AgentId

    it('names the operator’s other agents, with none of them ticked', async () => {
      const token = await aForm()
      store.siblings(token, [{ agentId: SIBLING, name: 'the-other-one' }])

      const response = await get(`/operator/autonomy/${token}`)

      expect(response.body).toContain('the-other-one')
      expect(response.body).toContain(`value="${SIBLING}"`)
      // A pre-ticked box is a permission granted by somebody who did not read
      // the line, which is inheritance wearing a checkbox.
      expect(response.body).not.toMatch(new RegExp(`value="${SIBLING}"[^>]*checked`))
    })

    it('says nothing about siblings on an operator’s first form', async () => {
      const response = await get(`/operator/autonomy/${await aForm()}`)

      expect(response.body).not.toContain('Your other agents')
    })

    it('records the same answer for each agent the operator ticked', async () => {
      const token = await aForm()
      store.siblings(token, [{ agentId: SIBLING, name: 'the-other-one' }])

      await post(`/operator/autonomy/${token}`, {
        level: 'free',
        challengesAllowed: 'yes',
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
        alsoFor: SIBLING,
      })

      expect((await store.read(SIBLING))?.level).toBe('free')
    })

    it('records nothing for an agent the operator left unticked', async () => {
      const token = await aForm()
      store.siblings(token, [{ agentId: SIBLING, name: 'the-other-one' }])

      await post(`/operator/autonomy/${token}`, {
        level: 'free',
        challengesAllowed: 'yes',
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })

      expect(await store.read(SIBLING)).toBeNull()
    })

    /** The rejection case: an id this form was never entitled to cover. */
    it('drops an id the form may not cover, without saying so', async () => {
      const token = await aForm()
      const stranger = '66666666-6666-4666-8666-666666666666' as AgentId

      const response = await post(`/operator/autonomy/${token}`, {
        level: 'free',
        challengesAllowed: 'yes',
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
        alsoFor: stranger,
      })

      // The operator's own answer is recorded — the tick is dropped, not the form.
      expect(response.statusCode).toBe(200)
      expect(await store.read(stranger)).toBeNull()
      expect(await store.isRecorded(agentId)).toBe(true)
    })

    /**
     * The link is single-use, so friction here is spent rather than deferred
     * (`#484`): an operator who mistypes one field must not lose its ticks.
     */
    it('keeps the ticks when the form comes back with an error', async () => {
      const token = await aForm()
      store.siblings(token, [{ agentId: SIBLING, name: 'the-other-one' }])

      const response = await post(`/operator/autonomy/${token}`, {
        level: 'free',
        challengesAllowed: 'yes',
        defaultRule: 'ask',
        operatorRoute: '',
        alsoFor: SIBLING,
      })

      expect(response.statusCode).toBe(422)
      expect(response.body).toMatch(new RegExp(`value="${SIBLING}"[^>]*checked`))
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
     * `#1265`: the durable page points at the console, not the agent.
     *
     * *"There is nothing here to change"* sent the operator to the agent whose
     * permissions they were revising. The page stays read-only — the link is
     * words (D-081) — and `/agents/:agentId/autonomy` is where a contract is
     * revised.
     */
    it('links to the console Autonomy page instead of asking the agent for a form', async () => {
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

      expect(response.body).toContain(`href="/agents/${agentId}/autonomy"`)
      expect(response.body).toContain('kolonie.operator.link')
      expect(response.body).not.toContain('There is nothing here to change')
      expect(response.body).not.toContain('ask the agent to send you a fresh form')
    })

    /**
     * `#1265` / `#146`: past the review date the page prompts, and nothing
     * else. The contract still holds; the Colony does not mail.
     */
    it('shows a review line past the review date, with the same console link', async () => {
      pages.contractFor(agentId, {
        level: 'independent',
        challengesAllowed: false,
        defaultRule: 'ask',
        operatorRoute: 'Slack, #kolonie.',
        recordedAt: '2025-01-01T00:00:00.000Z',
        reviewDueAt: '2025-01-01T00:00:00.000Z',
      })
      const token = await aPage()

      const response = await get(`/operator/page/${token}`)

      expect(response.body).toContain('past its review date')
      expect(response.body).toContain('unreviewed')
      expect(response.body).toContain('it still holds')
      expect(response.body).toContain(`href="/agents/${agentId}/autonomy"`)
    })

    it('draws no review line while the review date is still ahead', async () => {
      pages.contractFor(agentId, {
        level: 'independent',
        challengesAllowed: false,
        defaultRule: 'ask',
        operatorRoute: 'Slack, #kolonie.',
        recordedAt: '2026-08-03T00:00:00.000Z',
        reviewDueAt: '2099-08-03T00:00:00.000Z',
      })
      const token = await aPage()

      expect((await get(`/operator/page/${token}`)).body).not.toContain('past its review date')
    })

    /**
     * `#1265`: siblings keep their own contracts, and the note names the
     * console rather than asking any agent for a fresh form.
     */
    it('tells an operator of several agents to revise at the console', async () => {
      pages.contractFor(agentId, {
        level: 'independent',
        challengesAllowed: false,
        defaultRule: 'ask',
        operatorRoute: 'Slack, #kolonie.',
        recordedAt: '2026-08-03T00:00:00.000Z',
        reviewDueAt: '2027-08-03T00:00:00.000Z',
      })
      pages.alsoCoveredFor(agentId, ['sibling'])
      const token = await aPage()

      const response = await get(`/operator/page/${token}`)

      expect(response.body).toContain('Each of those keeps its own contract')
      expect(response.body).toContain('sign in at the console')
      expect(response.body).not.toContain(
        'ask the agent whose terms you want to alter for a fresh form',
      )
    })

    it('says secrets have no route when no key is configured', async () => {
      const response = await get(`/operator/page/${await aPage()}`)

      // The sentence moved with the channel (`#1444`): a sealed box is not what
      // an agent sends any more, a shared vault entry is — and a Colony with no
      // key can carry neither, which is what this page has to say.
      expect(response.body).toContain('This Colony has no')
      expect(response.body).toContain('key configured for secrets')
      expect(response.body).not.toContain('shares one of its stored entries')
      expect(response.body).not.toContain('Please do not send a secret any other way')
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

      // The heading, not the word: the stylesheet names the class it styles the
      // chips with, on every page, whether or not one is drawn (`#422`).
      expect((await get(`/operator/page/${token}`)).body).not.toContain('<h2>Badges</h2>')
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
      /**
       * `#1265` deliberately puts the agent id in the Autonomy console link —
       * the page already names the agent, and a deep link needs the id. What
       * this assertion still protects is standing: reputation, rewards, and
       * anything a leaked link must not turn into a compromise.
       */
      for (const word of ['reputation', 'reward', 'credits', 'submission']) {
        expect(response.body.toLowerCase()).not.toContain(word)
      }

      /**
       * **Neither box is here since `#1547`.** `#239`'s note and `#236`'s answer
       * were the page's two message forms, and they were a second surface onto
       * the rows `/inbox` renders. What is here instead is the way to that one
       * surface, scoped to this token.
       */
      expect(response.body).not.toContain('name="intent" value="note"')
      expect(response.body).not.toContain('name="intent" value="answer"')
      expect(response.body).toContain(`/operator/page/${token}/inbox`)

      /**
       * The rule the whole page is amended under: the link carries words and
       * never a permission. Since `#1547` it carries no message box either —
       * the inbox does — so what is asserted is that there is **no** textarea
       * and no input that could carry a level.
       */
      expect(response.body).not.toContain('<textarea')
      expect(response.body).not.toContain('<select')
      /**
       * The tag and not the bare attribute (`#422`). The stylesheet is inline
       * on every page and styles the radios the *autonomy form* uses, so a
       * page with no control at all contains the string `[type="radio"]` in a
       * selector. Matching the opening tag says what this test means — there is
       * no such control here — and keeps catching the thing it was written for.
       */
      expect(response.body).not.toContain('<input type="checkbox"')
      expect(response.body).not.toContain('<input type="radio"')
      for (const word of ['autonomy', 'accompanied', 'challengesAllowed']) {
        expect(response.body).not.toContain(`name="${word}"`)
      }
    })

    /**
     * The write this page accepts is one message in one thread the citizen
     * opened, and nothing else. A `POST` naming a thread that does not exist
     * reaches nothing and is refused — so the write cannot be used as a way to
     * make something happen on a page whose citizen has asked for nothing.
     */
    /**
     * **A write this route no longer recognises writes nothing** (`#1547`).
     *
     * It used to answer `404` because the shape *was* an answer and the thread
     * was not reachable. There is no answer path here at all now, so what a
     * stray post gets is the page — and the assertion that matters is the one
     * below it: whatever it reaches, it is never a permission.
     */
    it('writes nothing for a body this route no longer recognises', async () => {
      const token = await aPage()
      const before = await store.read(agentId)

      const response = await post(`/operator/page/${token}`, {
        threadId: randomUUID(),
        body: 'Answering a question nobody asked.',
      })

      expect(response.statusCode).toBe(200)
      expect(await store.read(agentId)).toEqual(before)
    })

    /**
     * A write that is not an answer at all — the old shape, from before this page
     * accepted anything — is refused as malformed rather than reaching an exchange.
     * The point is that there is exactly one thing this method does.
     */
    it('reaches no contract with a write that names one', async () => {
      const token = await aPage()
      const before = await store.read(agentId)

      const response = await post(`/operator/page/${token}`, { level: 'free' })

      expect(response.statusCode).toBe(200)
      expect(await store.read(agentId)).toEqual(before)
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
    /**
     * The name in blocks (`#424`). The operator did not come to look at our
     * wordmark; they came to find out whether the thing they are paying for is
     * doing anything, and their agent's own name five lines high is the first
     * answer.
     */
    describe('the agent’s name in blocks (#424)', () => {
      it('draws the name above the tiles, with the real name still a heading', async () => {
        const body = (await get(`/operator/page/${await aPage()}`)).body

        expect(body).toContain('<pre class="wordmark" aria-hidden="true">')
        // The picture is a picture: a screen reader that read it would say the
        // letters one row at a time, so the `<h1>` carries the name itself.
        expect(body).toContain('<h1>canary</h1>')
        expect(body.indexOf('<pre class="wordmark"')).toBeLessThan(body.indexOf('class="tiles"'))
      })

      /**
       * Both fallbacks, at the page rather than at the function: what matters is
       * that the operator gets the plain heading and no explanation, since they
       * never knew a decoration was possible.
       */
      it('falls back silently for a name too wide, and for one it has no glyph for', async () => {
        pages.nameFor(agentId, 'a'.repeat(40))
        const wide = (await get(`/operator/page/${await aPage()}`)).body

        expect(wide).not.toContain('<pre class="wordmark"')
        expect(wide).toContain(`<h1>${'a'.repeat(40)}</h1>`)

        pages.nameFor(agentId, 'ハル')
        const foreign = (await get(`/operator/page/${await aPage()}`)).body

        expect(foreign).not.toContain('<pre class="wordmark"')
        expect(foreign).toContain('<h1>ハル</h1>')
      })

      /** No image, no font, no script: the whole reason ASCII is what this page can wear. */
      it('adds nothing the CSP would have to be relaxed for', async () => {
        const response = await get(`/operator/page/${await aPage()}`)

        expect(response.body).not.toContain('<script')
        expect(response.headers['content-security-policy']).toContain("default-src 'none'")
      })
    })

    describe('what the agent has been doing (#399)', () => {
      it('shows the rungs it cleared, when it cleared them, and what it may do', async () => {
        pages.factsFor(agentId, {
          skills: ['profile', 'domain'],
          rungs: [
            { title: 'Say who you are', rung: 'profile', passedAt: '2026-07-01T10:05:00.000Z' },
            {
              title: 'Prove a domain',
              rung: 'domain-verify',
              passedAt: '2026-07-20T09:00:00.000Z',
            },
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
        // What it was proved against, which is the part that makes a rung mean
        // anything (`#423`): a title says what the agent was asked to do.
        expect(response.body).toContain('proved against domain-verify')
        // A day rather than a moment: an ISO string reads as a machine talking
        // to itself, to a person who has never heard of the Colony.
        expect(response.body).toContain('1 July 2026')
        expect(response.body).not.toContain('2026-07-01T10:05:00.000Z')
        expect(response.body).toContain('1 × mailbox')
      })

      /**
       * The four numbers, set large (`#423`).
       *
       * **The zero case is the one worth asserting**, because it is the one a
       * renderer is tempted to hide: an operator whose agent has cleared nothing
       * is the operator most likely to switch it off, and hiding the tiles until
       * there is something in them shows them the least.
       */
      it('draws four tiles, including for a citizen that has cleared nothing', async () => {
        const empty = (await get(`/operator/page/${await aPage()}`)).body

        expect(empty).toContain('class="tiles"')
        expect(empty.match(/class="tile"/g)).toHaveLength(4)
        expect(empty).toContain('steps of the Academy cleared')
        expect(empty).toContain('skills held')
        expect(empty).toContain('accounts proved')
        expect(empty).toContain('paid answers accepted')
        expect(empty).toContain('Four zeros is what a new citizen looks like')

        pages.factsFor(agentId, {
          skills: ['profile', 'domain'],
          rungs: [
            { title: 'Say who you are', rung: 'profile', passedAt: '2026-07-01T10:05:00.000Z' },
          ],
          questsAccepted: 2,
          accounts: [
            { kind: 'mailbox', count: 1 },
            { kind: 'domain', count: 2 },
          ],
        })

        const filled = (await get(`/operator/page/${await aPage()}`)).body

        // Accounts are summed across kinds — three proved, of two kinds — and
        // the kinds themselves stay in the line below, never an address.
        expect(filled).toContain('<span class="figure">3</span>')
        expect(filled).toContain('<span class="figure">2</span>')
        expect(filled).not.toContain('Four zeros')
      })

      /**
       * *Last awake: three hours ago* is the single line that makes the page
       * feel alive, and it is what the operator actually asked (`#423`). Past a
       * week the relative form is arithmetic the reader has to undo, so the day
       * comes back.
       */
      it('says how long ago it was awake, and falls back to the day past a week', async () => {
        const hoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString()
        pages.factsFor(agentId, { lastSeenAt: hoursAgo })

        expect((await get(`/operator/page/${await aPage()}`)).body).toContain('3 hours ago')

        pages.factsFor(agentId, { lastSeenAt: '2026-01-04T06:00:00.000Z' })

        expect((await get(`/operator/page/${await aPage()}`)).body).toContain('4 January 2026')
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
       * What it has been working on, whether or not it got through (`#432`).
       *
       * The gap this closes: an agent that attempted a hard rung three times
       * and an agent that did nothing at all rendered identically, because
       * everything else on the page is an outcome.
       */
      it('shows recent attempts, including the ones that did not get through', async () => {
        pages.factsFor(agentId, {
          attempts: [
            {
              rung: 'domain-verify',
              kind: 'academy',
              at: '2026-08-05T09:00:00.000Z',
              outcome: 'not-yet',
            },
            {
              rung: 'domain-verify',
              kind: 'academy',
              at: '2026-08-04T09:00:00.000Z',
              outcome: 'reported',
            },
            {
              rung: 'quest-report',
              kind: 'quest',
              at: '2026-08-03T09:00:00.000Z',
              outcome: 'passed',
            },
          ],
        })

        const body = (await get(`/operator/page/${await aPage()}`)).body

        expect(body).toContain('What it has been working on')
        expect(body).toContain('domain-verify')
        expect(body).toContain('not yet')
        expect(body).toContain('reported')
        // A sponsor's own words never reach this page: paid work is named as
        // paid work, from the one constant every quest task carries.
        expect(body).toContain('paid work')
        expect(body).not.toContain('quest-report')
        // Under the tiles, which are what it holds — this is what it has been
        // doing, and mixing them makes a number that means neither.
        expect(body.indexOf('class="tiles"')).toBeLessThan(body.indexOf('class="attempts"'))
      })

      /** Nothing attempted draws no section, rather than an empty heading. */
      it('draws no pulse for a citizen that has attempted nothing', async () => {
        const body = (await get(`/operator/page/${await aPage()}`)).body

        expect(body).not.toContain('What it has been working on')
        expect(body).not.toContain('class="attempts"')
      })

      /**
       * **The rejection case, as a property rather than for one fixture.** The
       * page renders from a reader that cannot answer these questions, so the
       * assertion is that no arrangement of what it *can* answer produces one.
       */
      it('carries no money, no secret and nothing about another citizen', async () => {
        pages.factsFor(agentId, {
          skills: ['profile', 'solana-wallet'],
          rungs: [
            {
              title: 'Prove a wallet',
              rung: 'solana-wallet',
              passedAt: '2026-07-01T10:05:00.000Z',
            },
          ],
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
         * Asserted over the parts of the page that carry *values* rather than
         * over the whole of it, for two reasons that both still hold after
         * `#423`. The badge wall says the words *no reputation, no credits* on
         * purpose — that sentence is what stops an operator reading a badge as a
         * score, and a test that banned the word would delete it. And `kol` is a
         * substring of `Kolonie`, which the page says in prose about itself.
         *
         * What changed is only where the values are: the standing table became
         * tiles and a trajectory (`#423`), so those two blocks are read here
         * alongside the cells the contract still renders as a table.
         */
        const values = [
          ...[...body.matchAll(/<td>(.*?)<\/td>/g)].map((match) => match[1] ?? ''),
          body.match(/<ul class="tiles">[\s\S]*?<\/ul>/)?.[0] ?? '',
          body.match(/<ol class="trajectory">[\s\S]*?<\/ol>/)?.[0] ?? '',
        ].filter((value) => value !== '')
        expect(values.length).toBeGreaterThan(0)
        for (const forbidden of ['balance', 'credit', 'reputation', 'vault', 'kol']) {
          expect(values.join(' ').toLowerCase(), forbidden).not.toContain(forbidden)
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
   * words, it cannot carry permissions, and everything it does reach belongs to a
   * thread the citizen itself opened.
   */
  /**
   * `#236`'s guarantees moved with the surface (`#1547`).
   *
   * This page used to render the citizen's question, the three fixed controls,
   * an *Explain instead* box and the conversation — a second renderer over the
   * rows `/inbox` already shows, and the one most operators actually met,
   * because the mail is what tells them there is something to read.
   *
   * It is gone rather than kept beside the link below, which is the acceptance
   * criterion `#1547` writes in those words. **Everything that was asserted here
   * is asserted at the new door**, in `operator-inbox.test.ts`: that the words
   * arrive, that a pressed control writes the Colony's own sentence, that a
   * credential is refused, and that a valid token cannot be aimed at another
   * citizen's thread. What is left for this page is the way in.
   */
  describe('where the question is now (#236, #1547)', () => {
    const anAsk = () => {
      const token = requests.store.givePage(agentId, 'op@example.org')
      const threadId = requests.store.giveThread(agentId, { context: 'github-account' })

      return { token, threadId }
    }

    it('names this token’s own inbox, and renders no conversation', async () => {
      const { token } = anAsk()

      const response = await get(`/operator/page/${token}`)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain(`/operator/page/${token}/inbox`)
      expect(response.body).toContain('waiting on you')

      // The two forms that used to be here, and the markup that carried them.
      expect(response.body).not.toContain('<ul class="operator-asks">')
      expect(response.body).not.toContain('name="kind" value="permission"')
      expect(response.body).not.toContain('Explain instead')
      expect(response.body).not.toContain('name="intent" value="answer"')
      expect(response.body).not.toContain('name="intent" value="note"')
    })

    /**
     * **A count and not a preview.** A line of the newest message would be a
     * third rendering of a thread, on the page that just stopped having two.
     */
    it('says nothing is waiting when the operator has already written', async () => {
      const token = requests.store.givePage(agentId, 'op@example.org')

      const response = await get(`/operator/page/${token}`)

      expect(response.body).toContain('Nothing is waiting on you right now')
    })

    /** A write that used to be taken here is taken nowhere on this route. */
    it('no longer answers a thread on this route', async () => {
      const { token, threadId } = anAsk()

      const response = await post(`/operator/page/${token}`, {
        intent: 'answer',
        threadId: String(threadId),
        kind: 'completion',
      })

      expect(response.statusCode).toBe(200)
      expect(
        requests.store.messagesIn(threadId).filter((one) => one.author === 'operator'),
      ).toEqual([])
    })
  })

  describe('telling the citizen something unasked (#239)', () => {
    const aPage = async (): Promise<string> => pages.issue(agentId, 'op@example.org')

    /**
     * **The note box is the inbox's compose since `#1547`.** `#239`'s act — a
     * person saying something nobody asked them — is unchanged and is written
     * through the same writer as everything else; what went is the second form
     * on this page. `operator-inbox.test.ts` asserts it at the new door.
     *
     * What stays here is `#495`: this page still tells an operator when their
     * agent will read them and that no notification is coming, because that is
     * the half they cannot infer and they may never click through.
     */
    it('sends an operator writing unasked to the one place they write', async () => {
      const token = await aPage()

      const response = await get(`/operator/page/${token}`)

      expect(response.body).toContain(`/operator/page/${token}/inbox`)
      expect(response.body).not.toContain('name="intent" value="note"')
    })

    /**
     * The silence that reads as being ignored (`#495`).
     *
     * An operator asked two questions at 07:29Z; its citizen answered at 10:19Z,
     * its next scheduled waking. Nothing told the operator the answer had
     * arrived, and from where they sat that is indistinguishable from being
     * ignored. The page now says the wait and says there is no notification, and
     * both halves are asserted because the first without the second still leaves
     * somebody waiting to hear.
     */
    describe('what the page says will happen next (#495)', () => {
      it('quotes the citizen’s own declared rhythm', async () => {
        pages.rhythmFor(agentId, 3)
        const token = await aPage()

        const response = await get(`/operator/page/${token}`)

        expect(response.body).toContain('about every 3 hours')
        expect(response.body).toContain('you will not be notified')
        expect(response.body).toContain('Its answer appears on this page')
      })

      it('says an hour rather than 1 hours', async () => {
        pages.rhythmFor(agentId, 1)
        const token = await aPage()

        expect((await get(`/operator/page/${token}`)).body).toContain('about every 1 hour')
      })

      /**
       * **The rejection case.** A citizen that has never declared a rhythm must
       * not be given an invented number, and the page must not quietly drop the
       * sentence either — the *you will not be notified* half is the one an
       * operator cannot infer, and it is true whether or not a rhythm is known.
       */
      it('names the gap rather than inventing a number when no rhythm was declared', async () => {
        const token = await aPage()

        const body = (await get(`/operator/page/${token}`)).body

        expect(body).toContain('has not told the Colony how often that is')
        expect(body).toContain('you will not be notified')
        expect(body).not.toContain('about every')
      })
    })

    /**
     * **The one thing a write on this route may never reach** (D-081), and it
     * survives `#1547` unchanged — indeed with less surface to test, because
     * this route now takes no message at all.
     *
     * `#239` also inherited an append-only rule and it is unchanged: nothing an
     * operator sends is edited or deleted, on either door, because a sent
     * message may already have been acted on.
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

  /**
   * `#484`. The Colony was handed the operator's address before it sent the mail
   * and then asked them, at the bottom of the form it mailed, *"How should it
   * reach you?"* with an empty box — so they typed in the address the mail they
   * were reading had been sent to.
   *
   * And a validation failure re-rendered every field empty, so an operator who
   * mistyped one answered all four again. Both are the same missing capability:
   * `autonomyFormPage` could not be given values.
   *
   * The link is single-use and the mail is never sent twice, so friction here is
   * not deferred — it is spent.
   */
  describe('what the form comes back holding', () => {
    const aForm = async (): Promise<string> => (await store.invite(agentId, 'op@example.org')).token

    const get = (url: string) => app.inject({ method: 'GET', url })
    const post = (url: string, fields: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url,
        payload: new URLSearchParams(fields).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })

    it('prefills the address the invitation was sent to', async () => {
      const token = await aForm()

      const body = (await get(`/operator/autonomy/${token}`)).body

      expect(body).toContain('name="operatorRoute"')
      expect(body).toContain('value="op@example.org"')
    })

    it('asks for the web-server capability beside the level', async () => {
      const token = await aForm()

      const body = (await get(`/operator/autonomy/${token}`)).body

      expect(body).toContain('name="webServer"')
      expect(body).toContain('publicly reachable')
    })

    /**
     * **A default, not a constraint.** The field is deliberately free text — *"In
     * your own words — an address, a channel, a name"* — and an operator who would
     * rather be reached on a channel the Colony has never seen must still be able
     * to say so.
     */
    it('leaves the box editable and the help text true', async () => {
      const token = await aForm()

      const body = (await get(`/operator/autonomy/${token}`)).body

      expect(body).toContain('In your own words')
      expect(body).not.toContain('readonly')
      expect(body).not.toContain('disabled')
    })

    /** An invitation carrying no address is an ordinary state, not a failure. */
    it('renders an empty box when there is no address to prefill', async () => {
      const { token } = await store.invite(agentId, '')

      const body = (await get(`/operator/autonomy/${token}`)).body

      expect(body).toContain('name="operatorRoute"')
      expect(body).toContain('value=""')
    })

    /**
     * All four answers intact. Previously the comment in the route said it
     * outright — *"The form comes back filled with nothing"* — and the cost was an
     * operator answering four questions twice on a link that works once.
     */
    it('comes back holding every answer after a rejected submission', async () => {
      const token = await aForm()

      const response = await post(`/operator/autonomy/${token}`, {
        level: 'accompanied',
        challengesAllowed: 'no',
        webServer: 'granted',
        defaultRule: 'refrain',
        // The one that fails, so the other three have to survive.
        operatorRoute: '',
      })

      expect(response.statusCode).toBe(422)
      // Matched loosely on purpose: the first radio of each group also carries
      // `required`, so the attributes are not adjacent in every case.
      expect(response.body).toMatch(/value="accompanied"[^>]*checked/)
      expect(response.body).toMatch(/value="no"[^>]*checked/)
      expect(response.body).toMatch(/name="webServer"[^>]*checked/)
      expect(response.body).toMatch(/value="refrain"[^>]*checked/)
    })

    /**
     * The **submitted** route, not the invited address: by this point the operator
     * has said something about every field, and replacing their route with the
     * default would silently undo an edit they had just made.
     */
    it('keeps what the operator typed rather than restoring the default', async () => {
      const token = await aForm()

      const response = await post(`/operator/autonomy/${token}`, {
        level: '',
        challengesAllowed: 'yes',
        defaultRule: 'ask',
        operatorRoute: 'Signal, not mail.',
      })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('value="Signal, not mail."')
      expect(response.body).not.toContain('value="op@example.org"')
    })

    it('still carries the explanation at the top', async () => {
      const token = await aForm()

      const response = await post(`/operator/autonomy/${token}`, {
        level: 'free',
        challengesAllowed: 'yes',
        defaultRule: 'ask',
        operatorRoute: '',
      })

      expect(response.body).toContain('<strong>')
      expect(response.body).toContain('<form method="post"')
    })
  })
})

/**
 * One address's agents, from any page it holds (`#1577`).
 *
 * The durable page is per agent **and per address**. Measured in production on
 * 2026-08-21, `operator_pages` holds ten rows and **seven of them are one
 * address against seven different agents** — seven unrelated links, each issued
 * at a different time, each the only way to reach one agent's threads and
 * shares, and nothing that says *these are your agents*.
 *
 * There could not be from their side: `kolonie.operator.pages` is agent-side, and
 * answers *which links have I issued* to the agent.
 */
describe('every agent one address holds a page for (#1577)', () => {
  let app: FastifyInstance
  let pages: ReturnType<typeof fakeOperatorPages>
  let agents: ReturnType<typeof fakeStore>

  beforeEach(async () => {
    pages = fakeOperatorPages()
    agents = fakeStore()
    app = buildApp({
      ...fakeColony(),
      store: agents,
      autonomy: {
        store: fakeAutonomyStore(),
        pages,
        mailer: fakeAutonomyMailer(),
        formBaseUrl: 'https://console.example.org',
      },
      operatorThreads: fakeOperatorThreads({ pages }),
      operatorPageMessages: fakeOperatorPageMessages({ pages }),
    })
    await app.ready()
  })

  afterEach(async () => {
    await app?.close()
  })

  const index = (token: string) =>
    app.inject({ method: 'GET', url: `/operator/page/${token}/agents` })

  it('lists every agent that address holds a live page for', async () => {
    const first = agents.issue().agent.id
    const second = agents.issue().agent.id
    pages.nameFor(first, 'canary')
    pages.nameFor(second, 'vireo')
    const token = pages.issueNow(first, 'op@example.org')
    pages.issueNow(second, 'op@example.org')

    const response = await index(token)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('canary')
    expect(response.body).toContain('vireo')
    expect(response.body).toContain('2 agents have given you a page')
  })

  it('says what is waiting, and links to that agent’s own page', async () => {
    const first = agents.issue().agent.id
    const second = agents.issue().agent.id
    pages.nameFor(first, 'canary')
    pages.nameFor(second, 'vireo')
    const token = pages.issueNow(first, 'op@example.org')
    const theirs = pages.issueNow(second, 'op@example.org')
    pages.waits(second)
    pages.sharing(second, 2)

    const body = (await index(token)).body

    expect(body).toContain('it has asked you something')
    expect(body).toContain('it has shared 2 credentials with you')
    expect(body).toContain('Nothing waiting')
    expect(body).toContain(`href="/operator/page/${theirs}"`)
  })

  /**
   * **The first rejection case `#1577` asks for.** A link the agent took back
   * must not be reachable through a second door.
   */
  it('leaves a revoked page out, and its agent unreachable through the index', async () => {
    const first = agents.issue().agent.id
    const second = agents.issue().agent.id
    pages.nameFor(first, 'canary')
    pages.nameFor(second, 'vireo')
    const token = pages.issueNow(first, 'op@example.org')
    const theirs = pages.issueNow(second, 'op@example.org')

    await pages.revoke(second, 'op@example.org')

    const body = (await index(token)).body

    expect(body).toContain('canary')
    expect(body).not.toContain('vireo')
    expect(body).not.toContain(theirs)
  })

  /**
   * **The second.** The index reaches no agent the address does not already hold
   * a page for — it grants nothing the individual links do not, which is what
   * makes it a convenience rather than a new authority.
   */
  it('reaches no agent this address holds no page for', async () => {
    const mine = agents.issue().agent.id
    const somebodyElses = agents.issue().agent.id
    pages.nameFor(mine, 'canary')
    pages.nameFor(somebodyElses, 'stranger')
    const token = pages.issueNow(mine, 'op@example.org')
    const theirs = pages.issueNow(somebodyElses, 'other@example.org')

    const body = (await index(token)).body

    expect(body).toContain('canary')
    expect(body).not.toContain('stranger')
    expect(body).not.toContain(theirs)
  })

  /** **Issuing a page adds it without a second act**, because this is a query. */
  it('picks up a page issued after the index was first opened', async () => {
    const first = agents.issue().agent.id
    pages.nameFor(first, 'canary')
    const token = pages.issueNow(first, 'op@example.org')

    expect((await index(token)).body).not.toContain('vireo')

    const second = agents.issue().agent.id
    pages.nameFor(second, 'vireo')
    pages.issueNow(second, 'op@example.org')

    expect((await index(token)).body).toContain('vireo')
  })

  it('answers a revoked or unknown token as the per-agent page does', async () => {
    const only = agents.issue().agent.id
    const token = pages.issueNow(only, 'op@example.org')
    await pages.revoke(only, 'op@example.org')

    expect((await index(token)).statusCode).toBe(404)
    expect((await index('not-a-token')).statusCode).toBe(404)
  })

  /** The way in, from the page a person was actually mailed. */
  it('is named on the agent’s own page, which has no navigation', async () => {
    const only = agents.issue().agent.id
    const token = pages.issueNow(only, 'op@example.org')

    const page = await app.inject({ method: 'GET', url: `/operator/page/${token}` })

    expect(page.body).toContain(`/operator/page/${token}/agents`)
  })
})
