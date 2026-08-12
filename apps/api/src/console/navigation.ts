/**
 * The console's navigation (`#608`, replacing `#431`'s row of links).
 *
 * `#431` decided the navigation was *"five links and a sign-out, because that is
 * everything a signed-in person can be looking for"*. That was true when it was
 * written and stopped being true four times over: a person gained a role
 * (`#485`), `/backend` grew five sections, the Atlas gained a curation queue
 * (`#549`), and one of the five links turned out to point at a deleted page
 * (`#605`). A row does not survive a sixth entry, and the answer is not a sixth
 * entry.
 *
 * The maintainer, 2026-08-08: *"es wird sicherlich zukünftig viel mehr
 * Menüpunkte geben, also dass wir das von Anfang an so denken … muss natürlich
 * auch alles mobile gedacht werden von Anfang an, das ist ganz wichtig."*
 *
 * ## Two levels, and a third would be one too many
 *
 * Sections with items under them. A third level is where a navigation stops
 * being read, and the shape below is the one `#608` specifies rather than one
 * invented here.
 *
 * ## No JavaScript, which decides the design rather than constraining it
 *
 * D-062. `<details>`/`<summary>` is the disclosure: native HTML, keyboard
 * operable, focusable, and it survives a stylesheet that never loads. The
 * section holding the page you are on is `open`; the rest are shut.
 *
 * **On a narrow screen the navigation is the top of the page**, collapsed to its
 * section headings, above the content. Not a drawer — a drawer that slides needs
 * a script, or the checkbox hack, which traps focus and lies to a screen reader
 * about what it is. The same markup does both; only the grid changes.
 *
 * ## Absent, never disabled
 *
 * `html.ts` has stated the rule since `#486` and it is enforced here: a person
 * who cannot use something should not learn it exists. A greyed entry tells
 * every visitor there is a door.
 *
 * ## Where the role question is asked
 *
 * **Once, in {@link ConsoleNav}, and the route asks the identical question.**
 * `#606`: *"the page and the navigation must ask the same question, or a steward
 * gets a link to a page that refuses them."* `/backend` is behind
 * `roles.includes('maintainer')` on the **signed-in human**, and so is the
 * section below.
 *
 * **Stewards are explicitly not in this navigation, which `#606` asks to be
 * decided rather than left open.** `/review` and `/numbers` are behind
 * `steward`, and that guard authenticates an **agent** — an API key or an
 * agent's session — not a person holding a role in this console. So a steward is
 * not a reader of this navigation at all, and an entry for those pages would be
 * an entry no reader of it can use. If a human ever holds `steward`, this is the
 * one place that changes, and the guard is the one place that has to change with
 * it.
 */

import { escape } from './escape.js'

/** What the navigation needs to know about its reader, and nothing else. */
export interface ConsoleNav {
  /**
   * The path of the page being rendered, for `aria-current` and for deciding
   * which section is open.
   *
   * A path and never a full URL: it is compared against the `href`s below.
   * Absent is legitimate — a page reached at a path the navigation does not
   * carry marks nothing, which is honest, rather than marking its nearest
   * relative.
   */
  readonly current?: string
  /**
   * Whether this person holds `maintainer` (`#485`).
   *
   * The same expression the `/backend` route evaluates. Not *is an admin* and
   * not *may see figures*: one role, one question, asked in two places that have
   * to agree.
   */
  readonly maintains?: boolean
}

interface NavItem {
  readonly href: string
  readonly label: string
}

interface NavSection {
  readonly title: string
  readonly items: readonly NavItem[]
}

/**
 * Every page under *Running the Colony*, in the order a maintainer meets them
 * (`#775`).
 *
 * ## Why these are paths and not fragments
 *
 * They were fragments into one long `/backend`, and `#608` said so in as many
 * words: *"the sections exist, they just have no way in."* Anchors gave them a
 * way in and nothing else. Three things stayed broken.
 *
 * **`aria-current` could only ever mark one of nine.** The attribute is set on
 * an exact `href` match, and eight of the nine hrefs carried a fragment no
 * request ever contains — so a reader with no CSS, on eight of the nine
 * sections, was told they were nowhere. `#583` is the identical defect on the
 * agent page and this is the identical fix.
 *
 * **Every view paid for every section.** Nine sequential reads ran before a byte
 * was written, whatever the maintainer had come for. A fragment is resolved by
 * the browser after the server has already done all of the work.
 *
 * **And there was one JSON representation for nine questions.** Asking
 * `/backend` for JSON returned every section's answer at once, which is not a
 * thing any caller wants and is nine queries a caller pays for to read one.
 *
 * ## One table, read twice
 *
 * The routes in `console-pages.ts` register these paths and `backend.ts` titles
 * its pages from them, so a path exists in one place. A link here with no route
 * behind it is caught by the crawl in `console-links.test.ts`.
 */
export const BACKEND_PAGES = [
  { href: '/backend', label: 'Numbers' },
  { href: '/backend/arrivals', label: 'Who arrived' },
  { href: '/backend/quests', label: 'Every quest' },
  { href: '/backend/briefings', label: 'Whether briefings help' },
  { href: '/backend/unreported', label: 'What nobody has reported on' },
  { href: '/backend/tickets', label: 'Waiting to be read' },
  { href: '/backend/enquiries', label: 'Providers writing in' },
  { href: '/backend/wanted', label: 'What agents are asking for' },
  { href: '/backend/atlas', label: 'The Atlas' },
  { href: '/backend/settings', label: 'Settings' },
] as const satisfies readonly NavItem[]

/**
 * What the navigation calls one of those paths, for the page's own `<h1>`.
 *
 * **Not `backendLabel`**, however much the entries are called labels:
 * `scripts/github-issue-labels.test.ts` reads every string literal out of a
 * function whose name contains *label*, in any file mentioning GitHub, and asks
 * whether it is an issue label the repositories carry. `Running the Colony` is
 * not, and the suite failed on it.
 */
export function backendTitle(path: string): string {
  return BACKEND_PAGES.find((entry) => entry.href === path)?.label ?? 'Running the Colony'
}

/**
 * The sections, in the order a signed-in person meets them.
 *
 * Agents first because that is what somebody signs in for; the account last
 * because it is the section you visit when something else has gone wrong.
 */
function sections(nav: ConsoleNav): readonly NavSection[] {
  return [
    {
      title: 'Your agents',
      items: [{ href: '/', label: 'All agents' }],
    },
    {
      title: 'Quests',
      items: [
        { href: '/quests', label: 'Written by your identities' },
        { href: '/quests/new', label: 'Write one' },
      ],
    },
    {
      title: 'Your account',
      /**
       * **`/key` is deliberately not here, and the crawl in
       * `console-links.test.ts` is what found that out.** The route
       * authenticates an *agent* — a key or an agent's session — so a person
       * signed in with GitHub gets a 404 from it. It was in this list for one
       * commit and the test failed with `['/key']`, which is the whole reason
       * that test exists. `/quests` links it for the reader who can use it.
       */
      items: [
        { href: '/account', label: 'Your account' },
        { href: '/sessions', label: 'Sessions' },
      ],
    },
    // Absent for everybody else, and that is the rule rather than an oversight.
    ...(nav.maintains === true ? [{ title: 'Running the Colony', items: BACKEND_PAGES }] : []),
  ]
}

/** The path an `href` points at, with any fragment dropped. */
const pathOf = (href: string): string => {
  const hash = href.indexOf('#')
  return hash === -1 ? href : href.slice(0, hash)
}

/**
 * The console's navigation, rendered.
 *
 * Returns markup and takes no request: the caller resolves who is reading and
 * what page they are on, which keeps this testable against a plain object and
 * keeps the role question in the routes where the guards are.
 */
export function consoleNavigation(nav: ConsoleNav): string {
  const rendered = sections(nav).map((section) => {
    const open = section.items.some((item) => pathOf(item.href) === nav.current)

    const items = section.items
      .map((item) => {
        /**
         * `aria-current="page"` is on the item whose path is this page — and on
         * at most one.
         *
         * **Every entry can now carry it, which is what `#775` was for.** While
         * *Running the Colony* was nine fragments into one path, an exact match
         * was reachable by exactly one of them and the other eight marked
         * nothing however the reader arrived. They are paths now, so the section
         * being read is the section marked.
         *
         * It is also how a reader with no CSS knows where they are, which is why
         * the styling hangs off the attribute rather than off a class.
         */
        const here = item.href === nav.current
        const current = here ? ' aria-current="page"' : ''
        return `<li><a href="${escape(item.href)}"${current}>${escape(item.label)}</a></li>`
      })
      .join('')

    return [
      `<details${open ? ' open' : ''}>`,
      `<summary>${escape(section.title)}</summary>`,
      `<ul>${items}</ul>`,
      '</details>',
    ].join('')
  })

  /**
   * **The sign-out is not in here**, and that is `#608`'s instruction rather
   * than an omission: *"the masthead keeps the mark and the sign-out — a
   * sign-out inside a collapsible section is a sign-out people cannot find."*
   * It sits in the top bar, above this, on every signed-in page.
   */
  return ['<nav class="console-nav" aria-label="Console">', ...rendered, '</nav>'].join('')
}
