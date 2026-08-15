import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
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
 * A wanted wish becomes the conversation it was always asking for (`#936`).
 *
 * **The wish list used to end at *wanted*.** An operator marked a provider, and
 * then both of them were on their own: nothing carried the mark into a place
 * where the work could actually be done. This door is the carry, and what it
 * asserts is therefore not what the handover asserts beside it — that one is an
 * account an operator already holds, this one is an account neither of them has
 * yet.
 *
 * **The Atlas is read on the far side and gates nothing here.** A provider the
 * Colony has recorded as refused opens exactly as one nobody has ever walked:
 * the citizen is told what somebody found and left to find out for itself. A
 * door that refused on the strength of a walk a year old would be the Colony
 * deciding, which is not what a catalogue is for.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let colony: FakeColony
let register: FakeAccountRegister
let threads: FakeAccountThreads
let agentId: AgentId

const build = () => {
  humans = fakeHumanStore()
  const pages = fakeOperatorPages()
  const agents = fakeStore()
  colony = fakeColony()
  register = fakeAccountRegister()
  // The trigger, as a function: the account and its thread are one statement.
  threads = fakeAccountThreads({ trigger: (accountId) => register.holder(accountId) })

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

/** Sign in and take the agent, exactly as the handover tests do. */
const operating = async (id: AgentId): Promise<string> => {
  const cookie = await signedInCookie()
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, human.id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
  threads.addOperator(id, String(human.id))
  return cookie
}

/** RFC 2606 hostnames throughout, per `AGENTS.md` §3. */
const FORM = {
  provider: 'mail.example',
  kind: 'mailbox',
  identifier: 'ariadne@mail.example',
} as const

const start = (cookie: string, payload: Record<string, string> = FORM) =>
  app.inject({
    method: 'POST',
    url: `/agents/${String(agentId)}/wishes/start`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    payload,
  })

/** The one acquisition the start opened. */
const started = async (id: AgentId) => {
  const open = await threads.openEpisodes(id)
  const first = open[0]
  if (first === undefined) throw new Error('nothing was opened')
  return first
}

describe('starting the conversation a wish was asking for', () => {
  it('makes the account, opens the acquisition and lands on the thread', async () => {
    const cookie = await operating(agentId)

    const response = await start(cookie)

    const held = await register.list(agentId)
    const account = held[0]
    expect(account).toBeDefined()
    expect(response.statusCode).toBe(303)
    expect(response.headers['location']).toBe(
      `/agents/${String(agentId)}/accounts/${String(account?.id)}`,
    )

    // Unproved: nobody has read anything yet, and that is the whole episode.
    expect(account?.proved).toBe(false)
    expect(account?.kind).toBe('mailbox')
    expect(account?.provider).toBe('mail.example')
    expect(account?.identifier).toBe('ariadne@mail.example')

    const { episode } = await started(agentId)
    expect(episode.kind).toBe('acquisition')
    expect(episode.openedBy).toBe('operator')
    expect(episode.turn).toBe('agent')
  })

  /**
   * `#582`: the kind and the provider, never the identifier. The title travels
   * into every list the agent reads, and an address does not belong in one.
   */
  it('names the kind and the provider in the title and not the address', async () => {
    const cookie = await operating(agentId)

    await start(cookie)

    const { episode } = await started(agentId)
    expect(episode.title).toContain('mailbox')
    expect(episode.title).toContain('mail.example')
    expect(episode.title).not.toContain('ariadne@')
  })

  it('lowercases the provider so it meets the Atlas on the Atlas’s own terms', async () => {
    const cookie = await operating(agentId)

    await start(cookie, { ...FORM, provider: '  MAIL.example ' })

    const held = await register.list(agentId)
    expect(held[0]?.provider).toBe('mail.example')
  })

  /**
   * The acceptance criterion the issue is actually about: the Atlas is read for
   * the page and never for the decision.
   */
  it('opens at a provider the Atlas records as refused', async () => {
    colony.recipes.write({ kind: 'mailbox', provider: 'shut.example', status: 'refused' })
    const cookie = await operating(agentId)

    const response = await start(cookie, {
      provider: 'shut.example',
      kind: 'mailbox',
      identifier: 'ariadne@shut.example',
    })

    expect(response.statusCode).toBe(303)
    expect(response.headers['location']).toContain('/accounts/')
    expect((await started(agentId)).episode.kind).toBe('acquisition')
  })

  it('says so on the thread page, where the refusal is a warning and not a wall', async () => {
    colony.recipes.write({ kind: 'mailbox', provider: 'shut.example', status: 'refused' })
    const cookie = await operating(agentId)

    await start(cookie, {
      provider: 'shut.example',
      kind: 'mailbox',
      identifier: 'ariadne@shut.example',
    })
    const held = await register.list(agentId)
    const page = await app.inject({
      method: 'GET',
      url: `/agents/${String(agentId)}/accounts/${String(held[0]?.id)}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('no honest route in')
    expect(page.body).toContain('Nothing is stopped by this')
  })

  it('hands the crib sheet over where somebody has walked the provider', async () => {
    colony.recipes.write({
      kind: 'mailbox',
      provider: 'mail.example',
      status: 'joinable',
      steps: [
        { actor: 'agent', instruction: 'sign up with the address you already hold' },
        { actor: 'operator', instruction: 'accept the terms' },
      ],
    })
    const cookie = await operating(agentId)

    await start(cookie)
    const held = await register.list(agentId)
    const page = await app.inject({
      method: 'GET',
      url: `/agents/${String(agentId)}/accounts/${String(held[0]?.id)}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(page.body).toContain('What somebody who walked')
    expect(page.body).toContain('sign up with the address you already hold')
    expect(page.body).toContain('A hint, not an instruction')
  })
})

describe('what the door refuses, and what it says instead', () => {
  it('starts nothing without a kind', async () => {
    const cookie = await operating(agentId)

    const response = await start(cookie, { provider: 'mail.example', identifier: 'a@mail.example' })

    expect(response.headers['location']).toBe(
      `/agents/${String(agentId)}/accounts?said=start-incomplete`,
    )
    expect(await register.list(agentId)).toHaveLength(0)
  })

  it('starts nothing without an identifier', async () => {
    const cookie = await operating(agentId)

    const response = await start(cookie, { provider: 'mail.example', kind: 'mailbox' })

    expect(response.headers['location']).toBe(
      `/agents/${String(agentId)}/accounts?said=start-incomplete`,
    )
    expect(await register.list(agentId)).toHaveLength(0)
  })

  it('starts nothing on a kind the Colony cannot read as one', async () => {
    const cookie = await operating(agentId)

    const response = await start(cookie, { ...FORM, kind: 'NOT A KIND' })

    expect(response.headers['location']).toContain('said=start-incomplete')
    expect(await register.list(agentId)).toHaveLength(0)
  })

  /**
   * Pressing it twice is the ordinary accident, and the second press has to say
   * what happened rather than open a second acquisition about one account.
   */
  it('says the conversation is already open when it is pressed again', async () => {
    const cookie = await operating(agentId)

    await start(cookie)
    const again = await start(cookie)

    expect(again.headers['location']).toBe(`/agents/${String(agentId)}/accounts?said=start-open`)
    expect(await register.list(agentId)).toHaveLength(1)
    expect(await threads.openEpisodes(agentId)).toHaveLength(1)
  })

  it('is not a door a stranger can push', async () => {
    const cookie = await signedInCookie()

    const response = await start(cookie)

    expect(response.statusCode).not.toBe(303)
    expect(await register.list(agentId)).toHaveLength(0)
  })
})
