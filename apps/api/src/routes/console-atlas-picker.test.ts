import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
import { LISTED_ATLAS_ENTRIES } from '@kolonie-ai/db'
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
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * Browsing the Atlas from the console (`#591`).
 *
 * The operator used to have to already know a hostname, so the agent — which has
 * `kolonie.accounts.recipes` — knew more about what was available than the
 * person did. These tests are about the two properties that make the fix worth
 * having: it shows what is already settled rather than hiding it, and it adds
 * without marking.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let colony: FakeColony
let agentId: AgentId
let strangersAgentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  const pages = fakeOperatorPages()
  const agents = fakeStore()
  colony = fakeColony()

  app = buildApp({
    ...colony,
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
  await app.ready()

  agentId = agents.issue().agent.id
  strangersAgentId = agents.issue().agent.id
  pages.exists(agentId)
  pages.exists(strangersAgentId)

  colony.recipes.write({
    kind: 'mailbox',
    provider: 'proton.me',
    title: 'Proton Mail',
    category: 'mailbox',
    status: 'unwritten',
    steps: [],
    proves: null,
  })
  colony.recipes.write({
    kind: 'mailbox',
    provider: 'fastmail.com',
    title: 'Fastmail',
    category: 'mailbox',
    status: 'unwritten',
    steps: [],
    proves: null,
  })
  colony.recipes.write({
    kind: 'github',
    provider: 'github.com',
    title: 'GitHub',
    category: 'code-hosting',
  })
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

const browse = (cookie: string, id: AgentId, query = '') =>
  app.inject({
    method: 'GET',
    url: `/agents/${id}/accounts/browse${query}`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
  })

const add = (cookie: string, id: AgentId, body: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: `/agents/${id}/wishes`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    payload: body,
  })

describe('browsing the catalogue from the console', () => {
  it('opens on the shelves, with a count each and no JavaScript', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await browse(cookie, agentId)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('mailbox')
    expect(response.body).toContain('code-hosting')
    expect(response.body).toContain('2 providers')
    expect(response.body).not.toContain('<script')
  })

  it('shows one shelf, with the category and the operator answer on every row', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await browse(cookie, agentId, '?category=mailbox')

    expect(response.body).toContain('Proton Mail')
    expect(response.body).toContain('Fastmail')
    // The shelf is the heading, so the category is on the page rather than
    // repeated on every row.
    expect(response.body).toContain('<h1>mailbox</h1>')
    expect(response.body).toContain('listed, and nobody has walked it yet')
    expect(response.body).toContain('who is needed is not known')
    // Another shelf's entries are not on this one.
    expect(response.body).not.toContain('GitHub')
  })

  /** A name in a link somebody edited is not a missing page. */
  it('lands on the shelves when the category is not one', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await browse(cookie, agentId, '?category=nonsense')

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Browse the Atlas')
  })

  it('adds one to the list, unmarked, and comes back to the shelf', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const added = await add(cookie, agentId, { provider: 'proton.me', category: 'mailbox' })

    expect(added.statusCode).toBe(303)
    expect(added.headers['location']).toBe(`/agents/${agentId}/accounts/browse?category=mailbox`)

    const wishes = await colony.wishes.store.list(agentId)
    expect(wishes).toHaveLength(1)
    // The mark is the decision that means something, and adding is not it.
    expect(wishes[0]?.wantedAt ?? null).toBeNull()
  })

  /**
   * **Shown, marked, and not offered again.** Hiding it makes an operator wonder
   * whether they missed it; offering it produces a duplicate the storage layer
   * then has to refuse, which is a refusal for doing what the page invited.
   */
  it('marks what is already on the list and offers no button for it', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    await add(cookie, agentId, { provider: 'proton.me', category: 'mailbox' })

    const response = await browse(cookie, agentId, '?category=mailbox')

    expect(response.body).toContain('already on the list')
    expect(response.body).toMatch(/Proton Mail[\s\S]*?already on the list/)
    // One button, for the entry that is not settled.
    expect(response.body.match(/Add to the list/g)).toHaveLength(1)
  })

  it('says so rather than duplicating when the same entry is added twice', async () => {
    const cookie = await signedInCookie()
    await link(agentId)
    await add(cookie, agentId, { provider: 'proton.me', category: 'mailbox' })

    const again = await add(cookie, agentId, { provider: 'proton.me', category: 'mailbox' })

    expect(again.headers['location']).toBe(
      `/agents/${agentId}/accounts/browse?category=mailbox&already=proton.me`,
    )
    expect(await colony.wishes.store.list(agentId)).toHaveLength(1)

    const shelf = await browse(cookie, agentId, '?category=mailbox&already=proton.me')
    expect(shelf.body).toContain('is already on the list, so nothing was added')
  })

  /**
   * The free-text field is the fallback and stays one: a provider the catalogue
   * has never heard of is exactly the signal `#534` is built on.
   */
  it('still takes a provider the catalogue does not know, from the field', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const added = await add(cookie, agentId, { provider: 'somewhere.example' })

    expect(added.statusCode).toBe(303)
    expect(added.headers['location']).toBe(`/agents/${agentId}`)
    expect(await colony.wishes.store.list(agentId)).toHaveLength(1)
  })

  it('is not reachable for an agent this person does not operate', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await browse(cookie, strangersAgentId, '?category=mailbox')

    expect(response.statusCode).toBe(404)
    expect(response.body).not.toContain('Proton Mail')
  })

  it('is not reachable without a session at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/accounts/browse`,
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * `#591`'s acceptance criterion, and the reason the picker takes entries as an
   * argument rather than reading anything itself: **one source.** A provider
   * name typed into the console is how one surface starts disagreeing with the
   * public Atlas, and the only way that stays true is if it is checked.
   *
   * **Substring matching over the whole file, comments included, and
   * deliberately blunt.** It has already fired once, on a doc comment quoting
   * the placeholder this page replaced — which is a false positive and was
   * cheaper to reword than to make the check clever. A test somebody can read in
   * one line is worth more here than one that is exactly right about which
   * occurrences count.
   */
  it('types no provider name into the console’s own code', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../console/atlas-picker.ts', import.meta.url)),
      'utf8',
    )

    for (const entry of LISTED_ATLAS_ENTRIES) {
      expect(source).not.toContain(entry.provider)
    }
  })
})
