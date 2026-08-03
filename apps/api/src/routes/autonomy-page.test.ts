import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony.js'
import { fakeAutonomyMailer, fakeAutonomyStore } from '../__fixtures__/autonomy.js'
import { fakeStore } from '../__fixtures__/store.js'
import type { AgentId } from '@kolonie-ai/core'

describe('the operator’s form', () => {
  let app: FastifyInstance
  let store: ReturnType<typeof fakeAutonomyStore>
  let agentId: AgentId

  beforeEach(async () => {
    store = fakeAutonomyStore()
    const agents = fakeStore()
    app = buildApp({
      ...fakeColony(),
      store: agents,
      autonomy: { store, mailer: fakeAutonomyMailer(), formBaseUrl: 'https://console.example.org' },
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
})
