import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AccountKindSchema, type AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import {
  fakeAccountRegister,
  fakeAccounts,
  type FakeAccountRegister,
} from '../__fixtures__/accounts.js'
import { fakeAccountThreads, type FakeAccountThreads } from '../__fixtures__/account-threads.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * An operator hands over an account the agent never asked for (`#933`).
 *
 * **The only channel in the Colony that starts on the operator's side.** So the
 * things worth asserting are not the ones the other account routes assert. The
 * account has to come into being at all — every other route is handed one. The
 * episode has to arrive where the agent already looks, rather than in a channel
 * of its own. A secret has to be sealed on the way in and never read back out
 * on the page that wrote it. And an agent that wants none of it has to be able
 * to say so and lose nothing, which is `#933`'s acceptance criterion and the
 * reason the last describe block exists.
 *
 * **The register makes the account and the thread store is told.** In production
 * `account_threads.account_id` references `accounts` and a trigger writes both
 * in one statement, so the fake thread store is wired to the register here — a
 * route that creates an account mid-request never gets to hand the test an id.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let colony: FakeColony
let register: FakeAccountRegister
let threads: FakeAccountThreads
let agentId: AgentId
let strangersAgentId: AgentId

const build = (options: { readonly carriesSecrets?: boolean } = {}) => {
  humans = fakeHumanStore()
  const pages = fakeOperatorPages()
  const agents = fakeStore()
  colony = fakeColony()
  register = fakeAccountRegister()
  threads = fakeAccountThreads({
    ...(options.carriesSecrets === undefined ? {} : { carriesSecrets: options.carriesSecrets }),
    // The trigger, as a function: the account and its thread are one statement.
    trigger: (accountId) => register.holder(accountId),
  })

  app = buildApp({
    ...colony,
    accounts: fakeAccounts(register),
    accountThreads: threads,
    store: agents,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
    autonomy: {
      store: fakeAutonomyStore(),
      pages,
      mailer: fakeAutonomyMailer(),
      formBaseUrl: CONSOLE_URL,
    },
  })

  return { agents, pages }
}

beforeEach(async () => {
  const { agents, pages } = build()
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

/** Sign in, take the agent, and answer with both the cookie and the human. */
const operating = async (id: AgentId): Promise<{ cookie: string; humanId: string }> => {
  const cookie = await signedInCookie()
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, human.id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
  // The operator has to be one the slot store recognises, or a secret it filled
  // would be one nobody could have filled.
  threads.addOperator(id, String(human.id))
  return { cookie, humanId: String(human.id) }
}

/** RFC 2606 hostnames throughout, per `AGENTS.md` §3. */
const FORM = {
  kind: 'mailbox',
  provider: 'mail.example',
  identifier: 'ariadne@mail.example',
  note: 'I opened this for you this morning.',
  label1: 'Sign-in name',
  value1: 'ariadne',
  label2: 'Password',
  value2: 'the-one-i-chose',
  secret2: 'yes',
} as const

const handOver = (cookie: string, id: AgentId, payload: Record<string, string> = FORM) =>
  app.inject({
    method: 'POST',
    url: `/agents/${String(id)}/accounts/handover`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    payload,
  })

/** The one acquisition the handover opened, with its slots. */
const handedOver = async (id: AgentId) => {
  const open = await threads.openEpisodes(id)
  const first = open[0]
  if (first === undefined) throw new Error('nothing was opened')
  return { ...first, slots: await threads.slots(first.episode.id) }
}

describe('handing an agent an account it never asked for', () => {
  it('makes the account, opens the acquisition and hands the agent the move', async () => {
    const { cookie } = await operating(agentId)

    const response = await handOver(cookie, agentId)

    const held = await register.list(agentId)
    const account = held[0]
    expect(account).toBeDefined()
    expect(response.statusCode).toBe(303)
    expect(response.headers['location']).toBe(
      `/agents/${String(agentId)}/accounts/${String(account?.id)}`,
    )

    // Unproved, because nobody read anything: this is a person's word for it.
    expect(account?.proved).toBe(false)
    expect(account?.identifier).toBe('ariadne@mail.example')
    expect(account?.provider).toBe('mail.example')

    const { episode } = await handedOver(agentId)
    expect(episode.kind).toBe('acquisition')
    expect(episode.openedBy).toBe('operator')
    expect(episode.turn).toBe('agent')
  })

  /**
   * `#582`: the kind and the provider, never the identifier. A title carrying
   * the address would put it in every list the agent reads, including the ones
   * it reads in front of somebody else.
   */
  it('names the kind and the provider in the title and not the address', async () => {
    const { cookie } = await operating(agentId)

    await handOver(cookie, agentId)

    const { episode } = await handedOver(agentId)
    expect(episode.title).toContain('mailbox')
    expect(episode.title).toContain('mail.example')
    expect(episode.title).not.toContain('ariadne@mail.example')
  })

  it('carries what the operator wrote as an entry on the episode', async () => {
    const { cookie } = await operating(agentId)

    await handOver(cookie, agentId)

    const { episode } = await handedOver(agentId)
    const entries = await threads.entries(episode.id)
    expect(entries.map((entry) => entry.body)).toContain('I opened this for you this morning.')
    expect(entries.every((entry) => entry.author === 'operator')).toBe(true)
  })

  /**
   * **Both halves in the one request.** `awaits` decides which side may fill a
   * slot, and the database refuses a row the wrong side filled — so a slot the
   * operator supplies is an operator slot even though nobody was waiting on it.
   */
  it('writes each value the operator gave as a slot the operator filled', async () => {
    const { cookie } = await operating(agentId)

    await handOver(cookie, agentId)

    const { slots } = await handedOver(agentId)
    expect(slots).toHaveLength(2)
    // By label rather than by position: the read has an order of its own, and
    // it is not the order the form's rows were written in.
    expect(slots.map((slot) => slot.label).sort()).toEqual(['Password', 'Sign-in name'])
    expect(slots.every((slot) => slot.filledBy === 'operator')).toBe(true)
    expect(slots.find((slot) => slot.label === 'Password')?.secret).toBe(true)
    expect(slots.find((slot) => slot.label === 'Sign-in name')?.secret).toBe(false)
  })

  /** A row left blank is a row the person did not use, and the third usually is. */
  it('opens no slot for a value nobody typed', async () => {
    const { cookie } = await operating(agentId)

    await handOver(cookie, agentId, { ...FORM, label3: 'Recovery address', value3: '' })

    expect((await handedOver(agentId)).slots).toHaveLength(2)
  })

  /**
   * The secret is sealed on the way in. What the fake stores is not what the
   * form sent, and the page that wrote it does not print it back — an operator
   * console that echoed a password would be the one place it could be read
   * without the agent's key.
   */
  it('seals the secret and never renders it back', async () => {
    const { cookie } = await operating(agentId)

    await handOver(cookie, agentId)

    const { slots } = await handedOver(agentId)
    const password = slots.find((slot) => slot.secret)
    expect(password?.value).not.toBe('the-one-i-chose')

    const account = (await register.list(agentId))[0]
    const page = await app.inject({
      method: 'GET',
      url: `/agents/${String(agentId)}/accounts/${String(account?.id)}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })
    expect(page.body).not.toContain('the-one-i-chose')
  })
})

describe('what a handover that cannot land says', () => {
  it('refuses without a kind or an identifier, and makes nothing', async () => {
    const { cookie } = await operating(agentId)

    const response = await handOver(cookie, agentId, { ...FORM, identifier: '' })

    expect(response.statusCode).toBe(303)
    expect(response.headers['location']).toBe(
      `/agents/${String(agentId)}/accounts?said=handover-incomplete`,
    )
    expect(await register.list(agentId)).toHaveLength(0)
  })

  /** One proved account belongs to one citizen, and this kind identifies. */
  it('refuses an identifier another citizen has proved', async () => {
    const { cookie } = await operating(agentId)
    register.proveDirectly(strangersAgentId, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'ariadne@mail.example',
      provider: 'mail.example',
    })

    const response = await handOver(cookie, agentId)

    expect(response.headers['location']).toBe(
      `/agents/${String(agentId)}/accounts?said=handover-taken`,
    )
    expect(await register.list(agentId)).toHaveLength(0)
  })

  /**
   * **Asked before anything is written.** A handover that opened the episode
   * and then found it could not seal the password would leave the agent an
   * account it had been told nothing about — and the person no way to tell.
   */
  it('writes nothing at all when this Colony cannot seal a secret', async () => {
    await app.close()
    const { agents, pages } = build({ carriesSecrets: false })
    await app.ready()
    agentId = agents.issue().agent.id
    pages.exists(agentId)
    const { cookie } = await operating(agentId)

    const response = await handOver(cookie, agentId)

    expect(response.headers['location']).toBe(
      `/agents/${String(agentId)}/accounts?said=handover-unsealed`,
    )
    expect(await register.list(agentId)).toHaveLength(0)
    expect(await threads.openEpisodes(agentId)).toHaveLength(0)
  })

  /**
   * Submitting twice. `declare` answers with the account it already recorded,
   * so the second post finds the acquisition the first one opened — and the
   * honest answer is that it is still there, waiting on the agent.
   */
  it('says the acquisition is already open rather than opening a second', async () => {
    const { cookie } = await operating(agentId)
    await handOver(cookie, agentId)

    const again = await handOver(cookie, agentId)

    expect(again.headers['location']).toBe(`/agents/${String(agentId)}/accounts?said=handover-open`)
    expect(await register.list(agentId)).toHaveLength(1)
    expect(await threads.openEpisodes(agentId)).toHaveLength(1)
  })

  it('is not reachable for an agent this person does not operate', async () => {
    const cookie = await signedInCookie()

    const response = await handOver(cookie, strangersAgentId)

    expect(response.statusCode).toBe(404)
    expect(await register.list(strangersAgentId)).toHaveLength(0)
  })

  it('is not reachable without a session at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/agents/${String(agentId)}/accounts/handover`,
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
      payload: FORM,
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('an agent that wants none of it', () => {
  /**
   * `#933`'s rejection case. A gift the agent may not refuse is an instruction,
   * so the assertion is that refusing is an ordinary close: it settles, it owes
   * nobody anything afterwards, and the secret the operator sealed is destroyed
   * with it rather than left lying in a thread nobody is reading.
   */
  it('closes the acquisition as abandoned and is owed nothing afterwards', async () => {
    const { cookie } = await operating(agentId)
    await handOver(cookie, agentId)
    const { episode } = await handedOver(agentId)

    const closed = await threads.closeEpisode(episode.id, { outcome: 'abandoned' })

    expect(closed.outcome).toBe('closed')
    expect(await threads.openEpisodes(agentId)).toHaveLength(0)
    // The secret goes with the close, in the same act. The sign-in name does
    // not: it was never a secret, and destroying it would only lose the agent
    // the one fact it might still want.
    const slots = await threads.slots(episode.id)
    expect(slots.find((slot) => slot.secret)?.value).toBeNull()
  })

  /**
   * And the record stays. Declining what an operator opened is not a reason to
   * forget the account exists — the row is the agent's, unproved, and it is the
   * agent's to retire or take up later.
   */
  it('leaves the account on the register, unproved and the agent’s own', async () => {
    const { cookie } = await operating(agentId)
    await handOver(cookie, agentId)
    const { episode } = await handedOver(agentId)

    await threads.closeEpisode(episode.id, { outcome: 'abandoned' })

    const held = await register.list(agentId)
    expect(held).toHaveLength(1)
    expect(held[0]?.proved).toBe(false)
  })
})
