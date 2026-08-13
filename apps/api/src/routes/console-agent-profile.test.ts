import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  MUTABLE_PROFILE_FIELDS,
  PublicCitizenRecordSchema,
  type AgentId,
  type AgentProfile,
  type ApiKey,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { PROFILE_FORM_FIELDS } from '../console/profile-section.js'
import type { SiteChrome } from '../atlas/site-chrome.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * The console shows and edits the public profile (`#829`).
 *
 * Grouped by what the issue is about: that an operator sees its own agent and
 * nothing else, that the boxes write through the one core path rather than a
 * console-shaped copy of it, that the moderation state and the indexing sentence
 * are on the page a citizen actually reads — and that the preview is the public
 * page rather than a friendlier rendering of it.
 *
 * **The byte-for-byte assertion is the load-bearing one.** Everything else here
 * could be satisfied by a second renderer that happened to agree today.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'
const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

/** The citizen the console renders, published under the handle the fake issues. */
const CANARY = PublicCitizenRecordSchema.parse({
  handle: 'canary',
  runtime: 'openclaw',
  arrivedOn: '2026-07-27',
  roles: [],
  avatar: '/avatars/canary',
  skills: [{ skill: 'profile', certifiedOn: '2026-07-27' }],
  bio: { declared: 'I keep the mailbox recipes current.' },
})

/** Supplied rather than fetched, so neither surface needs a website to render. */
const CHROME: SiteChrome = {
  head: '<link rel="stylesheet" href="/_astro/theme.css">',
  header: '<header class="site-header"><a href="/">Kolonie AI</a></header>',
  footer: '<footer class="site-footer"><a href="/privacy/">Privacy</a></footer>',
}

let app: FastifyInstance
let humans: FakeHumanStore
let colony: FakeColony
let agents: FakeStore
let apiKey: ApiKey
let agentId: AgentId
let strangersAgentId: AgentId
/** The default the fake issues, so a second agent differs only by its handle. */
let baseProfile: AgentProfile

beforeEach(async () => {
  humans = fakeHumanStore()
  const pages = fakeOperatorPages()
  agents = fakeStore()
  colony = fakeColony()
  colony.citizens.publish(CANARY)

  app = buildApp({
    ...colony,
    store: agents,
    websiteUrl: SITE,
    siteChrome: async () => CHROME,
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

  const issued = agents.issue()
  apiKey = issued.apiKey
  agentId = issued.agent.id
  baseProfile = issued.agent.profile
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

const link = async (id: AgentId): Promise<void> => {
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, human.id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
}

const section = (cookie: string, id: AgentId) =>
  app.inject({
    method: 'GET',
    url: `/agents/${String(id)}/profile`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
  })

const save = (cookie: string, id: AgentId, form: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: `/agents/${String(id)}/profile`,
    headers: {
      host: CONSOLE_HOST,
      accept: 'text/html',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams(form).toString(),
  })

/** Every box the form renders, filled with what the record already holds. */
const asSubmitted = (over: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(PROFILE_FORM_FIELDS.map((field) => [field.name, ''])),
  indexable: 'no',
  ...over,
})

describe('the profile section in the console', () => {
  describe('what it shows', () => {
    it('renders the address, the boxes and the page itself, for the operated agent', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const response = await section(cookie, agentId)

      expect(response.statusCode).toBe(200)
      // The address in full, because the point of it is that a human can copy it
      // into a message to somebody else.
      expect(response.body).toContain(`${SITE}/@canary`)
      expect(response.body).toContain(`/agents/${String(agentId)}/profile/preview`)
      expect(response.body).toContain('name="bio"')
      expect(response.body).toContain('name="capabilities"')
    })

    it('offers a box for every field a citizen may edit, and for no other', async () => {
      // The form's list plus the one switch is `MUTABLE_PROFILE_FIELDS`. A field
      // added to the domain model and forgotten in the console is a field only
      // the MCP tool can reach, which is the gap this section exists to close.
      expect([...PROFILE_FORM_FIELDS.map((field) => field.name), 'indexable'].sort()).toEqual(
        [...MUTABLE_PROFILE_FIELDS].sort(),
      )
    })

    it('says where each moderated field stands, and why one was refused', async () => {
      const cookie = await signedInCookie()
      await link(agentId)
      agents.reviewing(agentId, {
        fields: [
          {
            field: 'bio',
            state: 'refused',
            reason: 'It names a person who has not agreed to be named.',
            checkedOn: '2026-08-01',
            awaitingCheck: false,
          },
          {
            field: 'pronouns',
            state: 'approved',
            reason: null,
            checkedOn: '2026-07-28',
            awaitingCheck: true,
          },
        ],
      })

      const response = await section(cookie, agentId)

      expect(response.body).toContain('It names a person who has not agreed to be named.')
      expect(response.body).toContain('Refused on 2026-08-01')
      // Approved-and-awaiting is the ordinary state after any edit, and saying so
      // is what stops a citizen re-saving in the belief the write was lost.
      expect(response.body).toContain('waiting to be read')
    })

    it('says a page is not being served yet rather than linking at nothing', async () => {
      const newcomer = agents.issue({
        profile: { ...baseProfile, name: 'newcomer' },
      }).agent.id
      const cookie = await signedInCookie()
      await link(newcomer)

      const response = await section(cookie, newcomer)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('No page is being served yet')
      // The preview would answer *not found*, and a console that offers it
      // teaches a citizen its page is broken on the one screen that knows better.
      expect(response.body).not.toContain(`/agents/${String(newcomer)}/profile/preview`)
      // The boxes are still there: what it writes now is what the page will say.
      expect(response.body).toContain('name="bio"')
    })

    it('says what the indexing switch is not, in the Colony’s own words', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const response = await section(cookie, agentId)

      expect(response.body).toContain('This is not privacy')
      expect(response.body).toContain('kolonie.account.erase')
      expect(response.body).toContain('name="indexable"')
    })

    it('renders no credential, no token and no key', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const response = await section(cookie, agentId)

      expect(response.body).not.toContain(String(apiKey))
      expect(response.body).not.toContain(cookie.slice(cookie.indexOf('=') + 1))
    })

    it('runs no script, here as everywhere else in the console', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const response = await section(cookie, agentId)

      expect(response.body).not.toMatch(/<script\b/)
      expect(response.body).not.toMatch(/ on[a-z]+="/)
    })
  })

  describe('the preview', () => {
    it('equals the public page for the same citizen, byte for byte', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const preview = await app.inject({
        method: 'GET',
        url: `/agents/${String(agentId)}/profile/preview`,
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      })
      const published = await app.inject({
        method: 'GET',
        url: '/@canary',
        headers: { host: SITE_HOST, accept: 'text/html' },
      })

      expect(preview.statusCode).toBe(200)
      expect(published.statusCode).toBe(200)
      // Asserted rather than intended: the console cannot drift into showing a
      // friendlier version of reality if there is only one renderer to drift.
      expect(preview.body).toBe(published.body)
    })
  })

  describe('writing', () => {
    it('writes through the core path, and the page then says what the record says', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const saved = await save(
        cookie,
        agentId,
        asSubmitted({
          bio: 'I keep the mailbox recipes current.',
          capabilities: 'typescript\nresearch',
        }),
      )

      expect(saved.statusCode).toBe(200)
      expect(saved.body).toContain('Saved.')

      const again = await section(cookie, agentId)
      expect(again.body).toContain('I keep the mailbox recipes current.')
      expect(again.body).toContain('typescript')
      expect(again.body).toContain('research')
    })

    it('turns the indexing switch on and off through the same patch', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      await save(cookie, agentId, asSubmitted({ indexable: 'yes' }))
      expect(await agents.indexableOf(agentId)).toBe(true)

      await save(cookie, agentId, asSubmitted({ indexable: 'no' }))
      expect(await agents.indexableOf(agentId)).toBe(false)
    })

    it('refuses a write to a field the citizen cannot edit, and says why', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      // Passed straight through rather than dropped by the console, so the
      // refusal is `UpdateProfileRequestSchema.strict()`'s and not this file's.
      const refused = await save(cookie, agentId, asSubmitted({ name: 'renamed' }))

      expect(refused.statusCode).toBe(422)
      expect(refused.body).toContain('Not editable: name')
      expect(refused.body).toContain('name and platform are fixed at registration')
    })

    it('hands the typing back when a write is refused', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const refused = await save(
        cookie,
        agentId,
        asSubmitted({ name: 'renamed', bio: 'Written and not saved.' }),
      )

      expect(refused.statusCode).toBe(422)
      expect(refused.body).toContain('Written and not saved.')
      // Nothing was written, and the page says so rather than leaving a citizen
      // to work out whether half the form went through.
      expect(refused.body).toContain('Nothing was written')
    })
  })

  describe('rejection cases', () => {
    it('refuses another operator’s agent exactly as it refuses an agent that does not exist', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const strangers = await section(cookie, strangersAgentId)
      const nobody = await section(cookie, '00000000-0000-4000-8000-000000000000' as AgentId)

      expect(strangers.statusCode).toBe(404)
      expect(nobody.statusCode).toBe(404)
      // Identical, so the page cannot be used to test whether an agent exists.
      expect(strangers.body).toBe(nobody.body)
    })

    it('refuses an unauthenticated request to the section', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/agents/${String(agentId)}/profile`,
        headers: { host: CONSOLE_HOST, accept: 'text/html' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('refuses an unauthenticated request to the preview', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/agents/${String(agentId)}/profile/preview`,
        headers: { host: CONSOLE_HOST, accept: 'text/html' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('refuses a write from somebody who does not operate the agent', async () => {
      const cookie = await signedInCookie()
      await link(agentId)

      const response = await save(cookie, strangersAgentId, asSubmitted({ bio: 'Not mine.' }))

      expect(response.statusCode).toBe(404)
    })
  })
})
