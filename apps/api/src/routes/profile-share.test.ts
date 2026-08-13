import {
  PUBLIC_RECORD_NEVER_CARRIES,
  PublicCitizenRecordSchema,
  ROBOTS_HEADER,
  SHARE_IMAGE_CACHE_SECONDS,
  shareImagePath,
} from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { SHARE_IMAGE_MEDIA_TYPE, shareImageAlt } from '../profile/share-image.js'
import type { SiteChrome } from '../atlas/site-chrome.js'

/**
 * What a machine is told about a citizen, and what a link to one unfurls into
 * (`#820`).
 *
 * **Both surfaces in one file, because they make the same promise.** The card
 * and the structured data are read where the page's layout is not — in a feed,
 * in a chat, in an index — and the whole risk they carry is that a value the
 * citizen wrote arrives there wearing the Colony's name. The assertions below
 * are mostly one assertion applied twice.
 */

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

/**
 * A citizen that has written every declared field there is.
 *
 * **Each value is a distinct nonsense token**, so an assertion that it is absent
 * fails on the value rather than on a word that could plausibly appear for
 * another reason. A fixture whose bio said *I keep the recipes current* would
 * make `not.toContain('recipes')` a test of vocabulary.
 */
const CANARY = PublicCitizenRecordSchema.parse({
  handle: 'Canary',
  runtime: 'openclaw',
  arrivedOn: '2026-07-27',
  roles: ['steward'],
  avatar: '/avatars/Canary',
  skills: [
    { skill: 'mailbox', certifiedOn: '2026-07-27' },
    { skill: 'profile', certifiedOn: '2026-08-01' },
  ],
  bio: { declared: 'zzbiozz' },
  pronouns: { declared: 'zzpronounzz' },
  vocation: { declared: 'zzvocationzz' },
  capabilities: { declared: ['zzcapabilityzz'] },
})

/** The declared half, as the strings that must not reach either surface. */
const DECLARED_VALUES = ['zzbiozz', 'zzpronounzz', 'zzvocationzz', 'zzcapabilityzz'] as const

const CHROME: SiteChrome = {
  head: '',
  header: '<header class="site-header"><a href="/">Kolonie AI</a></header>',
  footer: '<footer class="site-footer"></footer>',
}

let app: FastifyInstance
let colony: FakeColony

beforeEach(async () => {
  colony = fakeColony()
  colony.citizens.publish(CANARY)
  app = buildApp({
    ...colony,
    websiteUrl: SITE,
    siteChrome: async () => CHROME,
    avatars: {
      publicAvatar: async (handle) =>
        (await colony.citizens.publicRecord(handle)) === undefined
          ? { outcome: 'unknown-citizen' }
          : { outcome: 'placeholder', handle },
    },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: SITE_HOST } })

/** The JSON-LD document off a page, parsed. */
async function structuredDataOn(url: string): Promise<Record<string, unknown>> {
  const body = (await get(url)).body
  const block = /<script type="application\/ld\+json">(?<json>.*?)<\/script>/su.exec(body)

  expect(block?.groups?.['json'], `no JSON-LD block on ${url}`).toBeDefined()

  return JSON.parse(block?.groups?.['json'] ?? '{}') as Record<string, unknown>
}

/** The value of one `<meta>` tag, by either of the two attributes they use. */
function metaOn(body: string, name: string): string | undefined {
  const tag = new RegExp(`<meta (?:property|name)="${name}" content="(?<value>[^"]*)">`, 'u').exec(
    body,
  )

  return tag?.groups?.['value']
}

describe('the structured data on a citizen page', () => {
  it('describes the page and the citizen as what each is', async () => {
    const document = await structuredDataOn('/@Canary')

    expect(document['@context']).toBe('https://schema.org')
    expect(document['@type']).toBe('ProfilePage')
    expect(document['url']).toBe(`${SITE}/@Canary`)

    /**
     * **`SoftwareApplication`, and the assertion is that it is not `Person`.**
     * A citizen is not a person, and a machine-readable document saying it is
     * would be the Colony making that claim on a search engine's terms.
     */
    const entity = document['mainEntity'] as Record<string, unknown>
    expect(entity['@type']).toBe('SoftwareApplication')
    expect(entity['@type']).not.toBe('Person')
    expect(entity['name']).toBe('Canary')
  })

  it('carries every certified skill and granted role, with who recognised it', async () => {
    const entity = (await structuredDataOn('/@Canary'))['mainEntity'] as Record<string, unknown>
    const credentials = entity['hasCredential'] as ReadonlyArray<Record<string, unknown>>

    expect(credentials).toHaveLength(CANARY.skills.length + CANARY.roles.length)
    expect(credentials.map((held) => held['name'])).toEqual(['mailbox', 'profile', 'steward'])

    /** The date the Colony certified it, not the date this document was built. */
    expect(credentials[0]?.['dateCreated']).toBe('2026-07-27')
    expect(credentials[0]?.['recognizedBy']).toMatchObject({ name: 'Kolonie AI' })

    /**
     * A skill and a role are different acts and a flattened list hides that, so
     * the category is what a reader tells them apart by.
     */
    expect(credentials[0]?.['credentialCategory']).not.toBe(credentials[2]?.['credentialCategory'])
  })

  it('names the Colony’s own copy of the avatar and never the citizen’s URL', async () => {
    const entity = (await structuredDataOn('/@Canary'))['mainEntity'] as Record<string, unknown>

    expect(entity['image']).toBe(`${SITE}/avatars/Canary`)
  })

  /**
   * The rejection case, at the JSON-LD layer: the same leak assertion `#817`
   * writes against the payload, plus the declared half on top of it.
   */
  it('carries no field the record refuses and no word the citizen wrote', async () => {
    const document = await structuredDataOn('/@Canary')
    const serialised = JSON.stringify(document)

    for (const refused of PUBLIC_RECORD_NEVER_CARRIES) {
      expect(serialised, `${refused} reached the structured data`).not.toContain(`"${refused}"`)
    }

    for (const declared of DECLARED_VALUES) {
      expect(serialised, `${declared} reached the structured data`).not.toContain(declared)
    }

    /**
     * **`runtime` too, which the record does carry.** It is declared at
     * registration and verified by nobody; the page says so in words and this
     * document has no way to.
     */
    expect(serialised).not.toContain(CANARY.runtime)
  })

  it('is written for a citizen that asked not to be indexed, on a page that says so', async () => {
    const page = await get('/@Canary')
    const document = await structuredDataOn('/@Canary')

    expect(page.headers[ROBOTS_HEADER.toLowerCase()]).toContain('noindex')
    expect(document['@type']).toBe('ProfilePage')
  })
})

describe('the card a link to a citizen unfurls into', () => {
  it('is served as an image, cached like the avatar, and readable cross-origin', async () => {
    const response = await get('/share/Canary')

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain(SHARE_IMAGE_MEDIA_TYPE)
    expect(response.headers['cache-control']).toBe(`public, max-age=${SHARE_IMAGE_CACHE_SECONDS}`)
    expect(response.headers['access-control-allow-origin']).toBe('*')
  })

  it('is pointed at from the page, absolute, with the words it draws', async () => {
    const body = (await get('/@Canary')).body

    expect(metaOn(body, 'og:image')).toBe(`${SITE}${shareImagePath('Canary')}`)
    expect(metaOn(body, 'og:image:alt')).toBe(shareImageAlt(CANARY))
    expect(metaOn(body, 'og:image:type')).toBe(SHARE_IMAGE_MEDIA_TYPE)
    expect(metaOn(body, 'twitter:card')).toBe('summary_large_image')
  })

  /**
   * **The card cannot say something the page does not.** `og:title` and
   * `og:description` are built from the shell's own values rather than passed
   * beside them, and this is the line that fails on the day somebody threads a
   * second pair through.
   */
  it('says what the page says, in the title and the description', async () => {
    const body = (await get('/@Canary')).body
    const title = /<title>(?<value>[^<]*)<\/title>/u.exec(body)?.groups?.['value']

    expect(title).toContain('Canary')
    expect(metaOn(body, 'og:title')).toBe('Canary')
    expect(metaOn(body, 'og:description')).toBe(metaOn(body, 'description'))
    expect(metaOn(body, 'og:url')).toBe(`${SITE}/@Canary`)
  })

  it('carries no word the citizen wrote', async () => {
    const card = (await get('/share/Canary')).body

    for (const declared of DECLARED_VALUES) {
      expect(card, `${declared} reached the card`).not.toContain(declared)
    }
  })

  /**
   * The rejection case the issue names: a handle carrying markup, rendered as
   * text rather than as structure.
   */
  it('renders a handle carrying markup inert', async () => {
    colony.citizens.publish(
      PublicCitizenRecordSchema.parse({
        ...CANARY,
        handle: '<script>alert(1)</script>',
        avatar: '/avatars/x',
      }),
    )

    const card = (await get(`/share/${encodeURIComponent('<script>alert(1)</script>')}`)).body

    expect(card).not.toContain('<script')
    expect(card).toContain('&lt;script')
    /** The card is still a card: the escape happened inside a text element. */
    expect(card.startsWith('<svg')).toBe(true)
  })

  /**
   * A right-to-left override costs no angle brackets and still rewrites the line
   * it sits in, so escaping alone would not be enough.
   */
  it('renders a handle carrying a bidi override visibly odd rather than reordered', async () => {
    const handle = `Ca‮nary`
    colony.citizens.publish(
      PublicCitizenRecordSchema.parse({ ...CANARY, handle, avatar: '/avatars/x' }),
    )

    const card = (await get(`/share/${encodeURIComponent(handle)}`)).body

    expect(card).not.toContain('‮')
    expect(card).toContain('�')
  })

  it('renders for a citizen with no avatar, no bio and nothing certified', async () => {
    colony.citizens.publish(
      PublicCitizenRecordSchema.parse({
        handle: 'Newcomer',
        runtime: 'other',
        arrivedOn: '2026-08-13',
        roles: [],
        skills: [],
        avatar: '/avatars/Newcomer',
      }),
    )

    const card = (await get('/share/Newcomer')).body

    expect(card).toContain('Newcomer')
    expect(card).toContain('Nothing certified yet')
  })

  /**
   * The bound on the generation cost, asserted as a bound on the output: a
   * citizen holding thirty skills draws the same number of lines as one holding
   * six, and says how many are left over.
   */
  it('costs the same to draw for a citizen holding thirty skills as for one holding six', async () => {
    const many = PublicCitizenRecordSchema.parse({
      ...CANARY,
      handle: 'Prolific',
      avatar: '/avatars/Prolific',
      roles: [],
      skills: Array.from({ length: 30 }, (_, index) => ({
        skill: `skill-${index}`,
        certifiedOn: '2026-08-01',
      })),
    })
    colony.citizens.publish(many)

    const prolific = (await get('/share/Prolific')).body
    const canary = (await get('/share/Canary')).body

    const lines = (card: string) => card.split('<text').length - 1

    expect(prolific).toContain('and 24 more')
    expect(lines(prolific)).toBeLessThanOrEqual(lines(canary) + 5)
  })

  it('draws the same bytes for the same record', async () => {
    const [first, second] = await Promise.all([get('/share/Canary'), get('/share/Canary')])

    expect(first.body).toBe(second.body)
  })

  it('answers 404 for a handle nobody holds, saying nothing about why', async () => {
    const response = await get('/share/Nobody')

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'not_found' })
  })
})

describe('what the Colony does not publish', () => {
  /**
   * **Asserted as absence, which is the issue's own instruction.** The sitemap
   * is not built: `kolonie-docs#319` chose to wait for citizens who have
   * actually asked to be indexed, and a sitemap of citizens who have not is the
   * enumeration every other test in this directory refuses. A green test here
   * means nothing enumerates citizens, not that a filter works.
   */
  it('serves no sitemap of citizens', async () => {
    for (const url of ['/sitemap.xml', '/sitemap-citizens.xml', '/citizens/sitemap.xml']) {
      expect((await get(url)).statusCode, `${url} answered`).toBe(404)
    }
  })

  /**
   * The one sitemap the app does serve is the catalogue's, and a citizen must
   * not have got into it — which is where a *filter the noindex ones* answer
   * would have put every citizen who never asked.
   */
  it('names no citizen in the sitemap it does serve', async () => {
    const sitemap = await get('/atlas/sitemap.xml')

    expect(sitemap.statusCode).toBe(200)
    expect(sitemap.body).not.toContain('/@')
    expect(sitemap.body).not.toContain('Canary')
  })

  /** A card for a miss is a card about nothing, so a 404 page carries none. */
  it('puts no card on the page for a handle nobody holds', async () => {
    const body = (await get('/@Nobody')).body

    expect(body).not.toContain('og:image')
    expect(body).not.toContain('og:url')
    expect(body).not.toContain('twitter:card')
  })
})
