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
      reward: { reputation: 0, lamports: 0 },
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
   * **No row is `You` any more** (`#578`).
   *
   * `#455` put the person's own minted identity in this list and labelled it
   * `You`, because it was an `agents` row under a generated name that nothing
   * else identified as them. Nothing mints one now: every author here is an
   * agent the person paired and named, so the list says the name.
   */
  it('names every author, because none of them is the person', async () => {
    const cookie = await signedInCookie()
    const own = anAgent({ name: 'a-named-agent' })
    humans.operatesAgent(theHuman().id, own)
    await wroteQuest(own.id, 'A quest my agent wrote')

    const body = (await section(cookie)).body

    expect(body).toContain('A quest my agent wrote')
    expect(body).toContain('a-named-agent')
    expect(body).not.toContain('>You<')
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

    // `#608`: the navigation is sections and items, so the entry carries the
    // label the item has rather than the section's name.
    expect(dashboard.body).toContain('<summary>Quests</summary>')
    expect(dashboard.body).toContain('<a href="/quests">Written by your identities</a>')
  })

  it('is not reachable without a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/quests',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * **Who may change which quest** (`#457`).
   *
   * Quests written through the person's own identity are theirs to act on;
   * quests written by an agent they operate are theirs to read and nothing
   * more. A human editing its agent's quest is a human acting *as* the agent,
   * which makes the console's own *"window rather than a control panel"*
   * sentence false and empties the boundary `#428` drew for operator notes.
   */
  describe('who may change which quest', () => {
    const anOperatedQuest = async (cookie: string) => {
      const agentId = agents.issue().agent.id
      await link(agentId)
      const written = await wroteQuest(agentId, 'My agent’s quest')
      return { agentId, questId: String(written.task.id), cookie }
    }

    const post = (questId: string, verb: string, cookie: string) =>
      app.inject({
        method: 'POST',
        url: `/quests/${questId}/${verb}`,
        headers: {
          host: CONSOLE_HOST,
          accept: 'text/html',
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
      })

    it('lets a person read their agent’s quest', async () => {
      const cookie = await signedInCookie()
      const { questId } = await anOperatedQuest(cookie)

      const response = await app.inject({
        method: 'GET',
        url: `/quests/${questId}`,
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('My agent’s quest')
    })

    it('lets a person read its results', async () => {
      const cookie = await signedInCookie()
      const { questId } = await anOperatedQuest(cookie)

      const response = await app.inject({
        method: 'GET',
        url: `/quests/${questId}/results`,
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      })

      expect(response.statusCode).toBe(200)
    })

    /** **A rejection case per verb**, which is what the issue asks for by name. */
    it('refuses to submit it', async () => {
      const cookie = await signedInCookie()
      const { questId } = await anOperatedQuest(cookie)

      const response = await post(questId, 'submit', cookie)

      expect(response.statusCode).toBe(403)
    })

    it('refuses to withdraw it', async () => {
      const cookie = await signedInCookie()
      const { questId } = await anOperatedQuest(cookie)

      const response = await post(questId, 'withdraw', cookie)

      expect(response.statusCode).toBe(403)
    })

    /**
     * **Funding is what submitting does**, in this console: `#174` reserves the
     * credits at submission, so refusing the submit is refusing the funding.
     * There is no separate fund route to refuse — asserted here so the absence
     * is a recorded fact rather than a gap somebody has to rediscover.
     */
    it('has no route that funds one separately', async () => {
      const cookie = await signedInCookie()
      const { questId } = await anOperatedQuest(cookie)

      expect((await post(questId, 'fund', cookie)).statusCode).toBe(404)
    })

    /**
     * **Editing an agent's draft is refused, and there is no console route for
     * editing anybody's yet** — so the guard is asserted on the verb that
     * exists and would carry it.
     */
    it('refuses to copy it into a draft of their own', async () => {
      const cookie = await signedInCookie()
      const { questId } = await anOperatedQuest(cookie)

      expect((await post(questId, 'copy', cookie)).statusCode).not.toBe(303)
    })

    /** The refusal is a sentence, naming the agent and what to do instead. */
    it('says whose it is and what to do instead', async () => {
      const cookie = await signedInCookie()
      const { agentId, questId } = await anOperatedQuest(cookie)

      const response = await post(questId, 'submit', cookie)

      expect(response.body).toContain(`agent-${String(agentId).slice(0, 4)}`)
      expect(response.body).toContain('ask it to change it')
    })

    /** And the page says so before somebody goes looking for the button. */
    it('states the rule on the quest itself', async () => {
      const cookie = await signedInCookie()
      const { agentId, questId } = await anOperatedQuest(cookie)

      const body = (
        await app.inject({
          method: 'GET',
          url: `/quests/${questId}`,
          headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
        })
      ).body

      expect(body).toContain(`This quest belongs to agent-${String(agentId).slice(0, 4)}`)
      expect(body).toContain('operating an agent does not make its work yours to edit')
      expect(body).not.toContain('Submit for review')
      expect(body).not.toContain('Withdraw from review')
    })

    /** A quest belonging to neither answers exactly as one that does not exist. */
    it('answers a stranger’s quest as a miss, on a write as well as a read', async () => {
      const cookie = await signedInCookie()
      await link(agents.issue().agent.id)
      const theirs = await wroteQuest(agents.issue().agent.id, 'Not mine')

      const write = await post(String(theirs.task.id), 'submit', cookie)
      const invented = await post('99999999-9999-4999-8999-999999999999', 'submit', cookie)

      expect(write.statusCode).toBe(invented.statusCode)
      expect(write.body).toBe(invented.body)
    })

    /**
     * **The rule now has no exception on this console** (`#578`).
     *
     * It used to: the person's own minted identity was an agent they could act
     * as from a browser, so this asserted that submitting *its* quest was not
     * refused. There is no such identity, and every agent a person operates is
     * one `#457` puts out of reach — so the refusal is uniform, which is what
     * this asserts instead.
     *
     * **What did not change is the agent's own key.** An agent submits its own
     * quest over the API exactly as before; the refusal is about a browser
     * session, not about the quest.
     */
    it('refuses through the browser whichever agent of theirs wrote it', async () => {
      const cookie = await signedInCookie()
      const own = anAgent({ name: 'a-named-agent' })
      humans.operatesAgent(theHuman().id, own)
      const mine = await wroteQuest(own.id, 'A quest my agent wrote')

      const response = await post(String(mine.task.id), 'submit', cookie)

      expect(response.statusCode).toBe(403)
    })
  })
})
