import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { QuestDraftSchema, type AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeQuests, type FakeQuestDesk } from '../__fixtures__/quests.js'
import { fakeHumanStore, fakeTenant, anAgent, type FakeHumanStore } from '../__fixtures__/humans.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * The console's Quests section (`#456`).
 *
 * **One human, several authors, one list.** `sponsorFor` answers with one
 * identity, so a person running four agents that had each written quests had no
 * view of those quests at all — the dashboard listed the agents, the quest
 * routes served one identity at a time, and nothing joined them.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let quests: FakeQuestDesk
let agents: ReturnType<typeof fakeStore>

beforeEach(async () => {
  humans = fakeHumanStore()
  quests = fakeQuests()
  agents = fakeStore()

  app = buildApp({
    ...fakeColony(),
    store: agents,
    quests,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
  })
  await app.ready()
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

const theHuman = () => {
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  return human
}

const link = async (id: AgentId): Promise<void> => {
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, theHuman().id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
}

/** A draft, written by whichever identity is named. */
const wroteQuest = async (authorId: AgentId, title: string) =>
  quests.create({
    authorId,
    draft: QuestDraftSchema.parse({
      title,
      description: 'What this quest is, for a human reading the catalogue.',
      instructions: 'Do the thing described and report what happened.',
      questions: [{ key: 'went-well', prompt: 'How did it go?', required: true }],
      slots: 10,
      reward: { credits: 0, reputation: 0 },
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      minReputation: 0,
      audience: 'citizens',
      proofVerifier: 'email-inbox',
    }),
  })

const section = (cookie: string) =>
  app.inject({
    method: 'GET',
    url: '/quests',
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
  })

describe('the quests a person’s identities have written', () => {
  it('lists quests written by every agent this person operates', async () => {
    const cookie = await signedInCookie()
    const first = agents.issue().agent.id
    const second = agents.issue().agent.id
    await link(first)
    await link(second)
    await wroteQuest(first, 'The first agent’s quest')
    await wroteQuest(second, 'The second agent’s quest')

    const body = (await section(cookie)).body

    expect(body).toContain('The first agent’s quest')
    expect(body).toContain('The second agent’s quest')
  })

  /**
   * Each row names its author, including when there is only one.
   *
   * The name asserted is the one `operated()` hands back — derived from the id
   * in the fake. What is being asserted is that the column carries *the
   * author's* name rather than being omitted when there is only one of them,
   * which is the criterion `#456` states explicitly.
   */
  it('names the author on every row', async () => {
    const cookie = await signedInCookie()
    const only = agents.issue().agent.id
    await link(only)
    await wroteQuest(only, 'A lone quest')

    const body = (await section(cookie)).body

    expect(body).toContain('A lone quest')
    expect(body).toContain('Written by')
    expect(body).toContain(`agent-${String(only).slice(0, 4)}`)
  })

  /**
   * **`You` is a row like any other** (`#455`), and the person's own identity is
   * in this list rather than above it.
   */
  it('calls the person’s own identity You', async () => {
    const cookie = await signedInCookie()
    const own = anAgent({ name: 'sponsor-abcd' })
    humans.holdsSponsor(theHuman().id, own)
    await wroteQuest(own.id, 'A quest I wrote myself')

    const body = (await section(cookie)).body

    expect(body).toContain('A quest I wrote myself')
    expect(body).toContain('>You<')
    expect(body).not.toContain('sponsor-abcd')
  })

  it('carries status, how full it is, and what it has cost', async () => {
    const cookie = await signedInCookie()
    const agentId = agents.issue().agent.id
    await link(agentId)
    const written = await wroteQuest(agentId, 'A quest with numbers')

    const body = (await section(cookie)).body

    expect(body).toContain('Status')
    expect(body).toContain('Filled')
    expect(body).toContain('Cost')
    expect(body).toContain('0 of 10')
    expect(body).toContain(`/quests/${String(written.task.id)}`)
  })

  /**
   * **Written, not answered.** What an agent did for somebody else's quest is a
   * different question about a different party and lives on the agent's page.
   */
  it('leaves out quests this person’s agents merely answered', async () => {
    const cookie = await signedInCookie()
    const mine = agents.issue().agent.id
    const strangers = agents.issue().agent.id
    await link(mine)
    await wroteQuest(strangers, 'Somebody else’s quest')
    quests.tookPartIn(mine, {
      questId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as never,
      title: 'Somebody else’s quest',
      at: new Date().toISOString() as never,
      outcome: 'accepted',
    })

    const body = (await section(cookie)).body

    expect(body).not.toContain('Somebody else’s quest')
  })

  /**
   * **The rejection case.** A quest written by somebody else's agent is not
   * reachable through this section, and asking for it directly answers as a
   * miss — indistinguishably from a quest that does not exist.
   */
  it('refuses a quest written by somebody else’s agent, as a miss', async () => {
    const cookie = await signedInCookie()
    await link(agents.issue().agent.id)
    const strangers = agents.issue().agent.id
    const theirs = await wroteQuest(strangers, 'Not mine to read')

    const listed = await section(cookie)
    const direct = await app.inject({
      method: 'GET',
      url: `/quests/${String(theirs.task.id)}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })
    const invented = await app.inject({
      method: 'GET',
      url: '/quests/99999999-9999-4999-8999-999999999999',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(listed.body).not.toContain('Not mine to read')
    expect(direct.statusCode).toBe(invented.statusCode)
    expect(direct.body).toBe(invented.body)
  })

  /** Two empty states, because the next step differs. */
  it('tells somebody with no agents how to get one', async () => {
    const cookie = await signedInCookie()

    const body = (await section(cookie)).body

    expect(body).toContain('you operate no agents')
    expect(body).toContain('/quests/new')
  })

  it('tells somebody whose agents have written nothing what would change that', async () => {
    const cookie = await signedInCookie()
    await link(agents.issue().agent.id)

    const body = (await section(cookie)).body

    expect(body).toContain('not by any agent you operate')
    expect(body).toContain('that is its decision and not yours')
  })

  /** It is reachable from the navigation on every signed-in page. */
  it('is in the console’s navigation', async () => {
    const cookie = await signedInCookie()

    const dashboard = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(dashboard.body).toContain('<a href="/quests">Quests</a>')
  })

  it('is not reachable without a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/quests',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })
})
