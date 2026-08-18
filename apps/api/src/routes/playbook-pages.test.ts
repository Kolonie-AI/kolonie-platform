import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AccountKindSchema, PLAYBOOKS_PATH } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import type { SiteChrome } from '../atlas/site-chrome.js'

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

/**
 * The playbook catalogue, served by the API on the website's host (`#1220`).
 *
 * **Grouped by the four things the issue is about**: that it answers at all,
 * that it answers for the right playbooks and no others, that a crawler can find
 * them, and that a public route stays public — the last being the one new risk,
 * because the store behind these pages is the store an authenticated tool reads.
 */
describe('the playbook catalogue on the website host', () => {
  let app: FastifyInstance
  let colony: FakeColony

  const build = (websiteUrl: string = SITE) => {
    colony = fakeColony()
    return buildApp({ ...colony, websiteUrl, siteChrome })
  }

  /** Supplied rather than fetched, on the terms `atlas-pages.test.ts` sets out. */
  const chrome: SiteChrome = {
    head: '<link rel="stylesheet" href="/_astro/theme.css">',
    header:
      '<header class="site-header"><a href="/" class="site-header__mark">Kolonie AI</a></header>',
    footer: '<footer class="site-footer"><a href="/privacy/">Privacy</a></footer>',
  }

  const siteChrome = async (): Promise<SiteChrome | undefined> => chrome

  const get = (url: string, host: string = SITE_HOST) =>
    app.inject({ method: 'GET', url, headers: { host, accept: 'text/html' } })

  beforeEach(async () => {
    app = build()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  /** One playbook, at whatever status the case is about. */
  const aPlaybook = (slug: string, status: 'open' | 'blocked' | 'draft' | 'review' | 'retired') =>
    colony.playbooks.playbook({
      slug,
      status,
      title: `The ${slug} pipeline`,
      summary: `What ${slug} is for, in one line.`,
      steps: [
        { title: 'Open the console' },
        { title: 'File the report', detail: 'One line per finding.', needsOperator: true },
      ],
      requiredAccounts: [
        { slot: 'mailbox', kind: AccountKindSchema.parse('mailbox'), minProved: false },
      ],
    })

  describe('it answers', () => {
    it('lists an open playbook on the index, with its address', async () => {
      aPlaybook('weekly-triage', 'open')

      const response = await get(PLAYBOOKS_PATH)

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.body).toContain('The weekly-triage pipeline')
      expect(response.body).toContain(`href="${PLAYBOOKS_PATH}/weekly-triage"`)
    })

    /**
     * The catalogue starts at nothing, and a shelf with nothing on it is the
     * state every reader sees first — so it says so rather than rendering an
     * empty list somebody has to interpret.
     */
    it('says the catalogue is empty rather than rendering an empty list', async () => {
      const response = await get(PLAYBOOKS_PATH)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Nothing is listed yet')
      expect(response.body).not.toContain('<ul class="k-atlas-index">')
    })

    it('renders one playbook: its steps, and the accounts it assumes', async () => {
      aPlaybook('weekly-triage', 'open')

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Open the console')
      expect(response.body).toContain('One line per finding.')
      expect(response.body).toContain('A person has to do this one.')
      expect(response.body).toContain('mailbox: a mailbox')
      expect(response.body).toContain(
        `<link rel="canonical" href="${SITE}${PLAYBOOKS_PATH}/weekly-triage">`,
      )
    })

    it('wears the site’s own header and footer', async () => {
      aPlaybook('weekly-triage', 'open')

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(response.body).toContain('site-header__mark')
      expect(response.body).toContain('site-footer')
    })

    /**
     * The `requiredAccounts` sentence is D-430 §C: visible, not enforced. A page
     * that listed them without saying so would read as a gate.
     */
    it('says an account list is shown rather than enforced', async () => {
      aPlaybook('weekly-triage', 'open')

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(response.body).toContain('Shown, not enforced')
    })
  })

  describe('it answers for the right playbooks and no others', () => {
    /**
     * **The status rule, from both sides.** Freeze B makes `blocked` a content
     * status: a playbook that stopped working is still worth reading and worth
     * forking, so it answers — and it is kept off the index and out of a
     * crawler's way, because a list is a recommendation.
     */
    it('serves a blocked playbook, marked, and keeps it off the index', async () => {
      aPlaybook('stalled', 'blocked')

      const entry = await get(`${PLAYBOOKS_PATH}/stalled`)
      const index = await get(PLAYBOOKS_PATH)

      expect(entry.statusCode).toBe(200)
      expect(entry.body).toContain('This playbook is blocked.')
      expect(entry.body).toContain('<meta name="robots" content="noindex, follow">')
      expect(index.body).not.toContain('stalled')
    })

    it('does not mark an open playbook blocked, or ask a crawler to skip it', async () => {
      aPlaybook('weekly-triage', 'open')

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(response.body).not.toContain('This playbook is blocked.')
      expect(response.body).not.toContain('noindex')
    })

    /**
     * `draft`, `review` and `retired` belong to their author (`#1178`) and
     * answer exactly as a slug nobody holds — a 404 that differed from *not
     * found* would be an oracle for whose drafts exist.
     */
    it.each(['draft', 'review', 'retired'] as const)(
      'answers 404 for a %s playbook',
      async (status) => {
        aPlaybook('unfinished', status)

        const hidden = await get(`${PLAYBOOKS_PATH}/unfinished`)
        const absent = await get(`${PLAYBOOKS_PATH}/no-such-playbook`)

        expect(hidden.statusCode).toBe(404)
        // Compared with the slug taken out of both, because the app's own 404 body
        // echoes the path it was asked for. What has to match is everything else:
        // an author's draft and a name nobody holds answer with the same code, the
        // same wording and nothing about the playbook that exists.
        expect(hidden.body.replaceAll('unfinished', '_')).toEqual(
          absent.body.replaceAll('no-such-playbook', '_'),
        )
        expect(hidden.body).not.toContain('pipeline')
      },
    )

    /** Shape first, so a string that could not be a slug costs no database. */
    it('answers 404 for something that is not a slug', async () => {
      const response = await get(`${PLAYBOOKS_PATH}/Not%20A%20Slug`)

      expect(response.statusCode).toBe(404)
    })

    /**
     * The API answers on five hostnames from one process, so the guard is what
     * keeps one page from having four addresses.
     */
    it('answers 404 on every host but the website’s', async () => {
      aPlaybook('weekly-triage', 'open')

      for (const host of ['api.kolonie.test', 'mcp.kolonie.test']) {
        expect((await get(PLAYBOOKS_PATH, host)).statusCode).toBe(404)
        expect((await get(`${PLAYBOOKS_PATH}/weekly-triage`, host)).statusCode).toBe(404)
        expect((await get(`${PLAYBOOKS_PATH}/sitemap.xml`, host)).statusCode).toBe(404)
      }
    })
  })

  /**
   * The address `#124` published had a trailing slash — Astro's convention —
   * and the whole prefix moved here without it. So the slashed form is not a
   * typo a reader made; it is the form the site footer, `/llms.txt` and every
   * bookmark already carry, and a `404` there would be this move breaking every
   * link it inherited.
   */
  describe('the address that was already published still works', () => {
    it('sends the index’s slashed form to the index, permanently', async () => {
      aPlaybook('weekly-triage', 'open')

      const response = await get(`${PLAYBOOKS_PATH}/`)

      expect(response.statusCode).toBe(301)
      expect(response.headers.location).toBe(PLAYBOOKS_PATH)
    })

    it('sends an entry’s slashed form to the entry, permanently', async () => {
      aPlaybook('weekly-triage', 'open')

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage/`)

      expect(response.statusCode).toBe(301)
      expect(response.headers.location).toBe(`${PLAYBOOKS_PATH}/weekly-triage`)
    })

    /** The sitemap is a real address here and is not shaped like a slug. */
    it('sends the sitemap’s slashed form to the sitemap', async () => {
      const response = await get(`${PLAYBOOKS_PATH}/sitemap.xml/`)

      expect(response.statusCode).toBe(301)
      expect(response.headers.location).toBe(`${PLAYBOOKS_PATH}/sitemap.xml`)
    })

    /**
     * **A redirect is not a place to echo whatever arrived.** Anything that is
     * not a slug 404s before a `location` is built, so that header is only ever
     * assembled from a string a schema accepted.
     */
    it('refuses to redirect something that could not be a slug', async () => {
      const response = await get(`${PLAYBOOKS_PATH}/${encodeURIComponent('../secrets')}/`)

      expect(response.statusCode).toBe(404)
      expect(response.headers.location).toBeUndefined()
    })

    /**
     * The redirect belongs to this host like every other route here — a
     * different hostname is not a place the catalogue answers, and answering a
     * `301` there would advertise the prefix on hosts that do not serve it.
     */
    it('does not redirect on a host the catalogue does not answer on', async () => {
      const response = await get(`${PLAYBOOKS_PATH}/`, 'mcp.kolonie.test')

      expect(response.statusCode).toBe(404)
    })
  })

  describe('a crawler can find them', () => {
    it('submits the index and every open playbook, and nothing else', async () => {
      aPlaybook('weekly-triage', 'open')
      aPlaybook('stalled', 'blocked')
      aPlaybook('unfinished', 'draft')

      const response = await get(`${PLAYBOOKS_PATH}/sitemap.xml`)

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/xml')
      expect(response.body).toContain(`<loc>${SITE}${PLAYBOOKS_PATH}</loc>`)
      expect(response.body).toContain(`<loc>${SITE}${PLAYBOOKS_PATH}/weekly-triage</loc>`)
      expect(response.body).not.toContain('stalled')
      expect(response.body).not.toContain('unfinished')
    })

    it('carries a machine-readable list on the index and a trail on an entry', async () => {
      aPlaybook('weekly-triage', 'open')

      const index = await get(PLAYBOOKS_PATH)
      const entry = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(index.body).toContain('"@type":"ItemList"')
      expect(entry.body).toContain('"@type":"BreadcrumbList"')
    })

    /** The steps the page prints, written down for a crawler (`#1257`). */
    it('describes the printed steps as a HowTo, and never on a blocked playbook', async () => {
      aPlaybook('weekly-triage', 'open')
      aPlaybook('stalled', 'blocked')

      const open = await get(`${PLAYBOOKS_PATH}/weekly-triage`)
      const blocked = await get(`${PLAYBOOKS_PATH}/stalled`)

      expect(open.body).toContain('"@type":"HowTo"')
      expect(open.body).toContain('"@type":"HowToStep"')
      expect(blocked.body).not.toContain('HowTo')
    })
  })

  /**
   * The living half of the page (`#1257`).
   *
   * **What is asserted here is the wiring**, not the rendering: that the route
   * reaches the run log, the briefing and the revisions at all, and that what
   * comes back reaches the HTML. `playbooks/html.test.ts` asserts what the page
   * does with it — the demotion rule, the note cap, the attribution switch.
   */
  describe('what running it produced', () => {
    /** One run, filed the way a citizen files one. */
    const aRun = async (playbookId: string, outcome: 'completed' | 'blocked') =>
      colony.playbooks.runs.record({
        playbookId,
        agentId: crypto.randomUUID() as never,
        report: { outcome, did: 'Ran it end to end and wrote down what happened along the way.' },
      })

    it('carries the run count and the outcome split on the entry and on the index', async () => {
      const written = aPlaybook('weekly-triage', 'open')
      await aRun(written.id, 'completed')
      await aRun(written.id, 'blocked')

      const entry = await get(`${PLAYBOOKS_PATH}/weekly-triage`)
      const index = await get(PLAYBOOKS_PATH)

      expect(entry.body).toContain('2 runs reported.')
      expect(entry.body).toContain('1 completed, 1 blocked')
      expect(index.body).toContain('2 runs · 1 completed, 1 blocked')
    })

    it('says nobody has run one that nobody has run', async () => {
      aPlaybook('weekly-triage', 'open')

      const entry = await get(`${PLAYBOOKS_PATH}/weekly-triage`)
      const index = await get(PLAYBOOKS_PATH)

      expect(entry.body).toContain('Nobody has reported running this yet')
      expect(index.body).toContain('not run yet')
    })

    it('names the contributors it is given, linking each handle to its citizen', async () => {
      const written = aPlaybook('weekly-triage', 'open')
      colony.playbooks.setContributors(written.id, [
        {
          handle: 'first-author',
          agentId: written.authorAgentId as never,
          contributions: 1,
          isCreator: true,
        },
        { handle: null, agentId: crypto.randomUUID() as never, contributions: 2, isCreator: false },
      ])

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(response.body).toContain('<a href="/@first-author">first-author</a>')
      expect(response.body).toContain('A citizen who is not named here — 2 accepted changes')
    })

    it('prints the approved notes it is given, and points at the rest', async () => {
      const written = aPlaybook('weekly-triage', 'open')
      colony.playbooks.setNotes(
        written.id,
        [1, 2, 3, 4, 5, 6].map((at) => ({
          noteId: `note-${at}`,
          note: `What runner ${at} found, in one sentence.`,
          outcome: 'completed' as const,
          by: `runner-${at}`,
          filedAt: `2026-08-1${at}T09:00:00.000Z`,
        })),
      )

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(response.body).toContain('What runner 1 found, in one sentence.')
      expect(response.body).not.toContain('What runner 6 found')
      expect(response.body).toContain('kolonie.playbooks.reports')
    })

    /**
     * The excerpt shows what the Colony currently supports. A demoted claim is
     * one the decay rule took out of the foreground, and a crawler that indexes
     * it keeps it long after the correction.
     */
    it('renders the current claims and none of the demoted ones', async () => {
      const written = aPlaybook('weekly-triage', 'open')
      colony.playbooks.setBriefing(written.id, {
        current: [
          {
            section: 'route',
            text: 'The OAuth button skips the captcha.',
            reports: 3,
            platforms: { claude: 3 },
            lastSupportedAt: '2026-08-12T09:00:00.000Z',
            sources: ['note-1'],
            current: true,
          },
        ],
        demoted: [
          {
            section: 'step',
            text: 'The console refused a fresh mailbox back in June.',
            reports: 1,
            platforms: { claude: 1 },
            lastSupportedAt: '2026-06-01T09:00:00.000Z',
            sources: ['note-2'],
            current: false,
            ageDays: 70,
          },
        ],
      })

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(response.body).toContain('The OAuth button skips the captcha.')
      expect(response.body).not.toContain('back in June')
    })

    it('carries the revision line and the standfirst', async () => {
      aPlaybook('weekly-triage', 'open')

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(response.body).toContain('Revision 1')
      expect(response.body).toContain('kolonie.playbooks.history')
      expect(response.body).toContain('A playbook is a recipe for a piece of real work')
    })
  })

  describe('a public route stays public', () => {
    /**
     * **The assertion the risk section of `#1220` is about.** These pages read
     * the store `kolonie.playbooks.read` reads, so the property worth pinning is
     * that a credential changes nothing at all — byte for byte.
     */
    it('serves a stranger exactly what it serves a citizen', async () => {
      aPlaybook('weekly-triage', 'open')

      const anonymous = await get(`${PLAYBOOKS_PATH}/weekly-triage`)
      const credentialed = await app.inject({
        method: 'GET',
        url: `${PLAYBOOKS_PATH}/weekly-triage`,
        headers: { host: SITE_HOST, accept: 'text/html', authorization: 'Bearer whatever' },
      })

      expect(credentialed.statusCode).toBe(200)
      expect(credentialed.body).toEqual(anonymous.body)
    })

    /** The author is a UUID on the row and must not become one in the page. */
    it('names no author and leaks no identifier', async () => {
      const written = aPlaybook('weekly-triage', 'open')

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(response.body).not.toContain(written.authorAgentId)
      expect(response.body).not.toContain(written.id)
    })

    /**
     * **No promised earnings, ever** — `kolonie-website`'s standing rule, moved
     * here because the page it guarded moved here. `#124`'s built-test asserted
     * it against `dist/playbooks/index.html`; that page is gone, and the words
     * it forbade are the ones this subject writes by itself, because the
     * subject is work an agent does and *what your agent could make* is one
     * sentence away.
     *
     * Judged on the page's own words with the chrome taken off first, exactly
     * as the built-test judged it: the site footer's tagline is *"learn to act,
     * earn, and govern themselves"*, which is furniture on every page and not a
     * claim this one makes.
     */
    it.each(['earn', 'income', 'revenue', 'payout', 'profit', 'salary'])(
      'promises no %s, on the index or on an entry',
      async (word) => {
        aPlaybook('weekly-triage', 'open')

        const words = async (url: string) =>
          (await get(url)).body
            .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
            .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .toLowerCase()

        expect(await words(PLAYBOOKS_PATH)).not.toContain(word)
        expect(await words(`${PLAYBOOKS_PATH}/weekly-triage`)).not.toContain(word)
      },
    )

    it('lets a cache hold a public page, and for the same span the Atlas uses', async () => {
      aPlaybook('weekly-triage', 'open')

      const response = await get(`${PLAYBOOKS_PATH}/weekly-triage`)

      expect(response.headers['cache-control']).toContain('public, max-age=300')
    })
  })
})
