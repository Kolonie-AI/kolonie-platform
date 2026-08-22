import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
import { fakeOperatorPageMessages } from '../__fixtures__/operator-page-message.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * **No console page renders an operator page token** (`#587`).
 *
 * `operator_pages.token` is a durable bearer credential, revoked only by the
 * agent. The console's queue rendered one in an `href` — so a screenshot, a
 * shared screen, a browser history entry or a referrer handed over permanent
 * write access to that agent's operator page, which `#239` bounds to *words,
 * never permissions*, but words into a citizen's context is not nothing.
 *
 * `#428` refuses a durable bearer link inside a page behind a login in as many
 * words, and `operator-page-body.ts` quotes it. **The forms obeyed it; the
 * queue's `href` did not** — which is exactly the shape of defect a rule stated
 * in prose and checked nowhere produces.
 *
 * So this is checked against the rendered output rather than argued about.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let pages: ReturnType<typeof fakeOperatorPages>
let requests: ReturnType<typeof fakeOperatorThreads>
let agentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  pages = fakeOperatorPages()
  requests = fakeOperatorThreads({ pages })
  const agents = fakeStore()

  app = buildApp({
    ...fakeColony(),
    store: agents,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
    autonomy: {
      store: fakeAutonomyStore(),
      pages,
      mailer: fakeAutonomyMailer(),
      formBaseUrl: CONSOLE_URL,
    },
    operatorThreads: requests,
    operatorPageMessages: fakeOperatorPageMessages({ pages }),
  })
  await app.ready()

  agentId = agents.issue().agent.id
  pages.exists(agentId)
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

const link = async (id: AgentId): Promise<void> => {
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, human.id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
}

/** A live page and an open question, which is the state that produced the link. */
const anOpenQuestion = (): { token: string; requestId: string } => {
  const token = pages.issueNow(agentId, 'operator@example.org')
  const threadId = requests.store.giveThread(agentId)

  return { token, requestId: String(threadId) }
}

describe('what the console renders about an operator page', () => {
  /**
   * The broad form, and the one worth keeping: not *this link is right* but
   * **no page behind the login contains the token anywhere** — not an `href`,
   * not a hidden field, not a comment.
   */
  it('renders the token nowhere on any page a session reaches', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const { token } = anOpenQuestion()

    // `/inbox` joined the list with `#1448`. `/agents/:id/messages` is not
    // here because it redirects into it — a 303 carries no body to inspect.
    for (const url of ['/', '/inbox', `/agents/${agentId}`, `/agents/${agentId}/operator`]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      })

      expect(response.statusCode).toBe(200)
      expect(response.body, `${url} carries the token`).not.toContain(token)
    }
  })

  /**
   * The rejection case. The console's door is reached by proving `operates()`,
   * so somebody who does not gets what they get for an id that names nothing —
   * the page cannot be used to test for agents.
   */
  it('gives nothing to a person who does not operate the agent', async () => {
    const strangers = fakeStore().issue().agent.id
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${strangers}/operator`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * **The mailed link keeps working exactly as before.** Nothing about
   * `answerAt` changed — it is correct for the surface it was written for, where
   * the token *is* how the operator is known.
   */
  it('still serves the mailed door on its token', async () => {
    const { token } = anOpenQuestion()

    const response = await app.inject({
      method: 'GET',
      url: `/operator/page/${token}`,
      headers: { accept: 'text/html' },
    })

    expect(response.statusCode).toBe(200)
    // `#1547`: what the page owes is the way in, not the conversation.
    expect(response.body).toContain(`/operator/page/${token}/inbox`)
  })

  /**
   * `#587`'s third part, as it stands after `#1547`.
   *
   * A page opened because somebody was asked something has to lead them to the
   * asking rather than to an ASCII wordmark and a contract. What changed is
   * where the asking *is*: the page stopped rendering the conversation, because
   * it was the second of two surfaces onto rows `/inbox` already renders. So
   * what both doors owe now is the way in — named, and reachable without
   * scrolling past a badge wall.
   */
  it('leads to the conversation from both doors', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    const { token } = anOpenQuestion()

    const mailed = await app.inject({
      method: 'GET',
      url: `/operator/page/${token}`,
      headers: { accept: 'text/html' },
    })
    const console = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/operator`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(mailed.body).toContain(`/operator/page/${token}/inbox`)
    expect(mailed.body).toContain('waiting on you')

    /**
     * **The console's door names the console's inbox** (`#428`): a durable
     * bearer link inside a page served behind a login is a credential leaking
     * downward for no gain.
     */
    expect(console.body).toContain(`/inbox?agent=${agentId}`)
    expect(console.body).not.toContain(`/operator/page/${token}`)
  })
})
