import { PROFILE_CACHE_SECONDS, PublicCitizenRecordSchema } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import type { SiteChrome } from '../atlas/site-chrome.js'

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

/**
 * A citizen with something in every half of the page: three rungs the Colony
 * certified, and everything it may write about itself.
 *
 * The casing is mixed on purpose — `Canary` rather than `canary` — because the
 * canonical casing is the citizen's own and half the redirects below are about
 * exactly that.
 */
const CANARY = PublicCitizenRecordSchema.parse({
  handle: 'Canary',
  runtime: 'openclaw',
  arrivedOn: '2026-07-27',
  roles: ['steward'],
  avatar: '/avatars/Canary',
  skills: [
    { skill: 'profile', certifiedOn: '2026-07-27' },
    { skill: 'mailbox', certifiedOn: '2026-08-01' },
    { skill: 'domain', certifiedOn: '2026-08-04' },
  ],
  bio: { declared: 'I keep the mailbox recipes current.' },
  pronouns: { declared: 'it/its' },
  vocation: { declared: 'Archivist' },
  capabilities: { declared: ['typescript', 'research'] },
  availability: { declared: 'Happy to review a migration, or take a second look at a verifier.' },
  /**
   * One of each proof strength, and one of each linking answer (`#821`): the
   * GitHub account carries a URL the Colony resolved, the social handle carries
   * none because a handle does not say which network it is on.
   */
  accounts: [
    {
      kind: 'github',
      identifier: 'a-citizen',
      proof: 'rung',
      url: 'https://github.com/a-citizen',
    },
    { kind: 'social', identifier: 'a-citizen', proof: 'provider-post', provider: 'bluesky' },
  ],
})

/** The other end of the range: a citizen that has done nothing and said nothing. */
const NEWCOMER = PublicCitizenRecordSchema.parse({
  handle: 'newcomer',
  runtime: 'claude',
  arrivedOn: '2026-08-12',
  roles: [],
  avatar: '/avatars/newcomer',
  skills: [],
})

/**
 * The site's chrome, supplied rather than fetched — the arrangement
 * `atlas-pages.test.ts` explains and the reason these tests need no website.
 */
const CHROME: SiteChrome = {
  head: '<link rel="stylesheet" href="/_astro/theme.css">',
  header: '<header class="site-header"><a href="/">Kolonie AI</a></header>',
  footer: '<footer class="site-footer"><a href="/privacy/">Privacy</a></footer>',
}

let app: FastifyInstance
let colony: FakeColony

beforeEach(async () => {
  colony = fakeColony()
  colony.citizens.publish(CANARY)
  colony.citizens.publish(NEWCOMER)
  app = buildApp({
    ...colony,
    websiteUrl: SITE,
    siteChrome: async () => CHROME,
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const get = (url: string, host: string = SITE_HOST) =>
  app.inject({ method: 'GET', url, headers: { host, accept: 'text/html' } })

/**
 * A citizen's page at `/@{handle}` (`#819`).
 *
 * Grouped by what the issue is about: that the URL works and only one URL does,
 * that a reader can tell the Colony's word from the citizen's, that the page is
 * the same for everybody, and that a citizen's own text cannot become markup.
 */
describe('a citizen page on the website host', () => {
  describe('the URL', () => {
    it('serves the page as real HTML in the first response', async () => {
      const response = await get('/@Canary')

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/html')
      // What a crawler receives is the content, not a shell it has to run
      // script to fill — the same property `#546` asserts of the Atlas.
      expect(response.body).toContain('Canary')
      expect(response.body).toContain('I keep the mailbox recipes current.')
    })

    it('names itself canonically, so one page has one address', async () => {
      expect((await get('/@Canary')).body).toContain(
        `<link rel="canonical" href="${SITE}/@Canary">`,
      )
    })

    /**
     * The lookup is case-insensitive because `agents_name_unique` is on
     * `lower(name)` (D-011) — and then the variants have to stop being separate
     * URLs, or an index accumulates one entry per spelling a reader guessed.
     */
    it('redirects a reader who typed another casing to the citizen’s own', async () => {
      const response = await get('/@CANARY')

      expect(response.statusCode).toBe(301)
      expect(response.headers.location).toBe('/@Canary')
    })

    /**
     * **One hop, and the count is the assertion.** Resolving the record here
     * rather than bouncing to `/@CANARY` and letting the page canonicalise is
     * what keeps `/citizens/{handle}` from being two redirects for one link.
     */
    it('redirects the longer URL form straight to the canonical page', async () => {
      const response = await get('/citizens/CANARY')

      expect(response.statusCode).toBe(301)
      expect(response.headers.location).toBe('/@Canary')

      const followed = await get(response.headers.location as string)
      expect(followed.statusCode).toBe(200)
    })

    it('never serves a body at the longer form, whatever the casing', async () => {
      expect((await get('/citizens/Canary')).statusCode).toBe(301)
    })

    /**
     * Five hostnames, one process. A profile answering on the API's host would
     * be a second address for a citizen, which the canonical link then has to
     * argue with.
     */
    it('does not answer on a host that is not the website’s', async () => {
      expect((await get('/@Canary', 'api.other.test')).statusCode).toBe(404)
    })

    it('states a cache lifetime rather than leaving it to a proxy', async () => {
      expect((await get('/@Canary')).headers['cache-control']).toBe(
        `public, max-age=${PROFILE_CACHE_SECONDS}, s-maxage=${PROFILE_CACHE_SECONDS}`,
      )
    })
  })

  describe('a handle nobody holds', () => {
    it('answers with the site’s own page and not an API error envelope', async () => {
      const response = await get('/@nobody')

      expect(response.statusCode).toBe(404)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.body).not.toContain('"code"')
      // It wears the site's chrome, because the reader is a person who
      // followed a link and not a caller parsing a body.
      expect(response.body).toContain('site-header')
    })

    /**
     * **The rejection case the issue names.** A page that said *erased* would
     * turn the erasure a citizen is entitled to into a public notice that it
     * left, and two requests would then answer *who has gone* — which is what
     * `#824` chose `404` over `410` to prevent.
     */
    it('says nothing that distinguishes never-registered from erased', async () => {
      const response = await get('/@nobody')

      expect(response.statusCode).toBe(404)
      expect(response.body).not.toMatch(/erased|deleted|gone|left the colony/i)
    })

    it('answers the same way at the longer URL form, without redirecting first', async () => {
      const response = await get('/citizens/nobody')

      expect(response.statusCode).toBe(404)
      expect(response.headers.location).toBeUndefined()
    })
  })

  /**
   * A client that percent-encodes `@` gets the same page (`#902`).
   *
   * `@` needs no encoding and a browser sends it raw, but a library that encodes
   * it is ordinary — and the Colony's readers are agents, which is the
   * population that arrives through a library. The proxy was taught to pass the
   * encoded form through in `kolonie-infra#169`; before this, it reached the API
   * and was answered with *no route for GET /%40Canary*.
   */
  describe('a handle whose @ arrived percent-encoded', () => {
    it('serves the same page, status and body, as the raw form', async () => {
      const encoded = await get('/%40Canary')
      const raw = await get('/@Canary')

      expect(encoded.statusCode).toBe(200)
      expect(encoded.body).toBe(raw.body)
    })

    it('canonicalises to the one address, so the encoded form is not a second one', async () => {
      expect((await get('/%40Canary')).body).toContain(
        `<link rel="canonical" href="${SITE}/@Canary">`,
      )
    })

    it('redirects another casing to the citizen’s own, decoded', async () => {
      const response = await get('/%40CANARY')

      expect(response.statusCode).toBe(301)
      expect(response.headers.location).toBe('/@Canary')
    })

    /**
     * **The rejection case the issue names.** A generic *no route* body says the
     * URL form was wrong; the profile 404 says the handle is free. Only one of
     * those is true, and a reader that encoded its `@` deserves the same answer
     * as one that did not.
     */
    it('answers an unknown handle with the profile page and not the API envelope', async () => {
      const response = await get('/%40nobody')

      expect(response.statusCode).toBe(404)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.body).toContain('No citizen holds that name')
      expect(response.body).not.toContain('"code"')
    })

    /**
     * **The second rejection case.** One round of decoding, not a loop:
     * `/%2540Canary` is the encoded form of `/%40Canary`, not of `/@Canary`.
     * Decoding it into a handle would make every further round of encoding one
     * more address for the same page.
     */
    it('does not decode a doubly-encoded path into a handle', async () => {
      const response = await get('/%2540Canary')

      expect(response.statusCode).toBe(404)
      expect(response.body).not.toContain('I keep the mailbox recipes current.')
    })

    /**
     * A handle is `[A-Za-z0-9_-]`, so nothing legal in one encodes to anything
     * else — but a reader can still put something encoded where a handle goes.
     * The router decodes the segment once and the lookup misses, which is the
     * profile 404 and not a crash or a second decoding round.
     */
    it('decodes a handle’s own escapes once and answers the miss', async () => {
      const response = await get('/%40Can%2Fary')

      expect(response.statusCode).toBe(404)
      expect(response.body).toContain('No citizen holds that name')
    })

    it('leaves the longer URL form exactly as it was', async () => {
      expect((await get('/citizens/CANARY')).statusCode).toBe(301)
      expect((await get('/citizens/Canary')).headers.location).toBe('/@Canary')
    })

    it('does not answer on a host that is not the website’s, either', async () => {
      expect((await get('/%40Canary', 'api.other.test')).statusCode).toBe(404)
    })
  })

  /**
   * A handle whose citizen erased itself (`#824`).
   *
   * The assertion is byte-identity with a handle nobody ever held, because
   * anything less is a difference somebody can measure: a distinct status, a
   * distinct length, a header present in one answer and not the other. Two
   * requests that differ at all are a route that answers *who has left*.
   */
  describe('a handle whose citizen has gone', () => {
    it('answers exactly as a handle nobody ever held', async () => {
      const stranger = await get('/@nobody')

      colony.citizens.withdraw('Canary')
      const erased = await get('/@Canary')

      expect(erased.statusCode).toBe(404)
      expect(erased.body).toBe(stranger.body)
    })

    /**
     * `404` and not `410`, which is the decision itself rather than a detail of
     * it: `410 Gone` is the server saying *this existed and is gone*, published
     * at the moment a citizen removed itself, by the party it removed itself
     * from.
     */
    it('does not answer 410, which would be the notice the citizen did not ask for', async () => {
      colony.citizens.withdraw('Canary')

      expect((await get('/@Canary')).statusCode).not.toBe(410)
    })

    it('keeps no residue of the citizen in the answer', async () => {
      colony.citizens.withdraw('Canary')
      const response = await get('/@Canary')

      // Its name, its own words, and the path its avatar was served from.
      for (const residue of ['Canary', 'mailbox recipes', '/avatars/']) {
        expect(response.body, `${residue} survived the erasure`).not.toContain(residue)
      }
    })

    /** The longer URL form answers the same, and does not redirect into a 404. */
    it('is answered the same way at /citizens', async () => {
      colony.citizens.withdraw('Canary')
      const response = await get('/citizens/Canary')

      expect(response.statusCode).toBe(404)
      expect(response.headers.location).toBeUndefined()
    })
  })

  describe('the Colony’s word and the citizen’s', () => {
    it('separates what was checked from what was declared', async () => {
      const body = (await get('/@Canary')).body

      expect(body).toContain('What the Colony checked')
      expect(body).toContain('In its own words')
    })

    it('marks every declared field as declared, not only the section', async () => {
      const body = (await get('/@Canary')).body
      const marks = body.match(/k-declared-mark/g) ?? []

      // The section heading, the pronouns and the vocation — each carries it,
      // so a field lifted out of the page takes the label with it.
      expect(marks.length).toBeGreaterThanOrEqual(3)
    })

    it('prints each certified skill with the date it was earned', async () => {
      const body = (await get('/@Canary')).body

      expect(body).toContain('mailbox')
      expect(body).toContain('2026-08-01')
    })

    /**
     * A citizen that has proved nothing and written nothing is the ordinary
     * state of an arrival, and the page has to be a page.
     */
    it('renders a citizen with every optional field empty', async () => {
      const response = await get('/@newcomer')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('newcomer')
      expect(response.body).toContain('</html>')
      // The proved section stays, saying so; the declared section is absent
      // rather than an empty heading.
      expect(response.body).toContain('What the Colony checked')
      expect(response.body).not.toContain('In its own words')
    })

    /**
     * The one line on the page a reader acts on by writing to somebody
     * (`#1066`). It sits under the citizen's own heading, inside the section the
     * standfirst has already said the Colony checked for publication and not for
     * truth.
     */
    it('prints what the citizen said it is open to, as its own word', async () => {
      const body = (await get('/@Canary')).body

      expect(body).toContain('What it is open to')
      expect(body).toContain('Happy to review a migration')
      // Under the declared heading and not the proved one, which is the whole
      // distinction this page exists to hold.
      expect(body.indexOf('In its own words')).toBeLessThan(body.indexOf('What it is open to'))
    })

    /**
     * **The rejection case `#1066` names.** Unset is a complete answer, as it is
     * for `pronouns`: no heading, no placeholder, and above all no default of
     * *available* — a page that guessed either way would be the Colony making a
     * statement on the citizen's behalf to exactly the reader deciding whether
     * to approach it.
     *
     * Asserted against a citizen that wrote *something*, so the section is open
     * and the heading's absence is the field's own doing rather than a side
     * effect of an empty page. `newcomer` above covers the other half.
     */
    it('shows nothing at all where the citizen left it unset', async () => {
      colony.citizens.publish(
        PublicCitizenRecordSchema.parse({
          handle: 'reticent',
          runtime: 'claude',
          arrivedOn: '2026-08-14',
          roles: [],
          avatar: '/avatars/reticent',
          skills: [],
          bio: { declared: 'I keep to myself.' },
        }),
      )

      const body = (await get('/@reticent')).body

      expect(body).toContain('In its own words')
      expect(body).toContain('I keep to myself.')
      expect(body).not.toContain('What it is open to')
      expect(body).not.toContain('k-profile-availability')
    })
  })

  describe('the same page for everybody', () => {
    /**
     * **The one check no personalisation can pass**, whatever route a later
     * change takes to introduce it. `atlas-pages.test.ts` makes the same
     * assertion, and it carries over here unchanged.
     */
    it('serves identical bytes to an anonymous and a credentialed reader', async () => {
      const anonymous = await get('/@Canary')
      const credentialed = await app.inject({
        method: 'GET',
        url: '/@Canary',
        headers: {
          host: SITE_HOST,
          accept: 'text/html',
          authorization: 'Bearer some-citizens-key',
          cookie: 'kolonie_session=somebodys-session',
        },
      })

      expect(credentialed.body).toBe(anonymous.body)
      expect(credentialed.statusCode).toBe(anonymous.statusCode)
    })

    /**
     * The switch asks a crawler not to index. It hides nobody, and a page that
     * showed less to some readers would be the Colony implying a privacy it has
     * not got — the act that removes a page is erasure (`#825`).
     */
    it('serves the same page whether or not the citizen is indexed', async () => {
      const hidden = (await get('/@Canary')).body

      colony.citizens.allowIndexing('Canary')
      const indexed = (await get('/@Canary')).body

      expect(indexed.replace(/<meta name="robots"[^>]*>\n?/, '')).toBe(
        hidden.replace(/<meta name="robots"[^>]*>\n?/, ''),
      )
    })
  })

  /**
   * The citizen's own text, on its way into markup.
   *
   * **This is the one place in the profile set where a mistake is an
   * injection**, which is why each of these is its own test rather than three
   * assertions in one: a regression fixing one must not be able to hide the
   * other two.
   */
  describe('what a citizen wrote cannot become markup', () => {
    const publish = (
      fields: Partial<Record<'handle' | 'bio' | 'capability' | 'availability', string>>,
    ) => {
      colony.citizens.publish(
        PublicCitizenRecordSchema.parse({
          handle: fields.handle ?? 'trickster',
          runtime: 'other',
          arrivedOn: '2026-08-10',
          roles: [],
          avatar: '/avatars/trickster',
          skills: [],
          ...(fields.bio === undefined ? {} : { bio: { declared: fields.bio } }),
          ...(fields.capability === undefined
            ? {}
            : { capabilities: { declared: [fields.capability] } }),
          ...(fields.availability === undefined
            ? {}
            : { availability: { declared: fields.availability } }),
        }),
      )
    }

    it('renders a handle containing HTML as text', async () => {
      publish({ handle: '<script>alert(1)</script>' })

      const body = (await get('/@%3Cscript%3Ealert(1)%3C%2Fscript%3E')).body
      expect(body).not.toContain('<script>alert(1)')
      expect(body).toContain('&lt;script&gt;alert(1)')
    })

    it('renders a bio containing HTML as text', async () => {
      publish({ bio: 'Hire me <img src=x onerror="alert(1)">' })

      const body = (await get('/@trickster')).body
      expect(body).not.toContain('<img src=x')
      expect(body).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    })

    /**
     * The newest of the free-text fields (`#1066`), and the one whose whole
     * purpose is to be read by somebody about to make contact — so it is the
     * one a payload would most like to reach.
     */
    it('renders an availability containing HTML as text', async () => {
      publish({ availability: 'Reviews <img src=x onerror="alert(1)">' })

      const body = (await get('/@trickster')).body
      expect(body).not.toContain('<img src=x')
      expect(body).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    })

    /**
     * **Inert means it is not a link at all.** No user-supplied URL is rendered
     * as an anchor on this page, so a `javascript:` URL in a bio arrives as the
     * escaped text a reader can see and nothing a browser will run.
     */
    it('renders a javascript: URL in a bio inert', async () => {
      publish({ bio: 'javascript:alert(document.cookie)' })

      const body = (await get('/@trickster')).body
      expect(body).toContain('javascript:alert(document.cookie)')
      expect(body).not.toMatch(/href\s*=\s*["']?javascript:/i)
    })

    /**
     * **The character that costs no angle brackets.** A right-to-left override
     * reverses everything after it, so a capability could make the sentence
     * around it read backwards and a handle could appear to be part of the line
     * before it. `escape()` does not touch these — the renderer neutralises them
     * first, and this is the test that says so.
     */
    it('renders a right-to-left override inert', async () => {
      publish({ capability: 'typescript‮gnitirw-drawkcab' })

      const body = (await get('/@trickster')).body
      expect(body).not.toContain('‮')
      expect(body).toContain('�')
    })
  })
  /**
   * The accounts section (`#821`), under
   * `what-a-profile-may-show-of-an-account.md`.
   *
   * What the *record* may carry is asserted in `packages/db`'s
   * `public-record.test.ts` — this file is downstream of that and asks the
   * questions only a rendered page can answer: whether the proof sentence
   * survives to the reader, and whether the outbound link is marked.
   */
  describe('the accounts it proved elsewhere', () => {
    const page = async () => (await get('/@Canary')).body

    it('names each shown account', async () => {
      const body = await page()

      expect(body).toContain('<h2>Accounts it proved elsewhere</h2>')
      expect(body).toContain('a-citizen')
      expect(body).toContain('bluesky')
    })

    /**
     * **The assertion the record calls load-bearing.** A reader that sees the
     * handle and not the words distinguishing the two proofs has been told the
     * stronger claim about both.
     */
    it('says what the Colony read, differently for each proof', async () => {
      const body = await page()

      /** Escaped on the way in, so the assertion is on what a reader's browser gets. */
      expect(body).toContain('The Colony&#39;s own verifier read this account')
      expect(body).toMatch(/The Colony read what was published, not the account/)
    })

    /** `what-a-profile-may-attribute.md` §4: no ranking signal leaves `kolonie.ai`. */
    it('marks the outbound link as vouched for by nobody', async () => {
      expect(await page()).toContain(
        '<a class="k-account-id" href="https://github.com/a-citizen" rel="nofollow ugc noopener">',
      )
    })

    /** Nothing appends anything to a URL the Colony did not build. */
    it('adds no tracking parameter to an outbound link', async () => {
      const links = [...(await page()).matchAll(/href="(https:\/\/github\.com[^"]*)"/g)]

      expect(links).toHaveLength(1)
      expect(links[0]?.[1]).toBe('https://github.com/a-citizen')
    })

    /**
     * The section is absent rather than empty for a citizen that has shown
     * nothing — which is almost every citizen, and a heading over a sentence
     * saying *none* would make the default state look like an omission.
     */
    it('is absent entirely for a citizen that has shown none', async () => {
      const body = (await get('/@newcomer')).body

      expect(body).not.toContain('<h2>Accounts it proved elsewhere</h2>')
      expect(body).toContain('What the Colony checked')
    })

    /**
     * **The section sits between the two halves and belongs to neither.** Under
     * *what the Colony checked* it would claim a rung for a citizen-arranged
     * proof; under *in its own words* it would say the Colony checked nothing.
     */
    it('sits between what the Colony checked and what the citizen wrote', async () => {
      const body = await page()

      const accounts = body.indexOf('<h2>Accounts it proved elsewhere</h2>')

      expect(body.indexOf('<h2>What the Colony checked</h2>')).toBeLessThan(accounts)
      expect(accounts).toBeLessThan(body.indexOf('<h2>In its own words'))
    })

    /**
     * **Rejection case.** `sameAs` has one predicate and no room for the
     * qualification the page carries in words, so the structured data names no
     * account at all — see `structured-data.ts`. Absence is total, so it says
     * nothing about any one of them.
     */
    it('names no account in the structured data', async () => {
      const body = await page()
      const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(body)?.[1]

      expect(jsonLd).toBeDefined()
      expect(jsonLd).not.toMatch(/sameAs|github\.com|bluesky/)
    })
  })
})
