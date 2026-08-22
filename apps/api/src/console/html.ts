/**
 * The console's HTML, written out (`#179`).
 *
 * **No framework, no build step, no bundle.** The entire surface is forms and
 * tables. A bundler, a component library and a hydration story would be cost
 * with no matching benefit, and each one is a thing the next agent has to learn
 * before it can change a label. There is no JavaScript in anything this file
 * renders — which is also what makes the CSP below as strict as it is.
 *
 * One page did carry script, and it was deliberately not here (`#738`): the
 * operator's window onto a shared browser tab, a stream of pictures and a stream
 * of clicks that could not be a form. It lived in its own module so the claim
 * above stayed a claim about this file. It left with the channel behind it
 * (`#912`), and the console is once again forms and tables throughout.
 *
 * **Every value that reaches a page goes through {@link escape}.** A quest's
 * title is a stranger's text, a citizen's answer is another's, and this is the
 * one surface where either is rendered rather than served as JSON. There is a
 * test that puts a script tag in a title and asserts it comes back inert.
 *
 * **The stylesheet moved out in `#422`** and is now the Colony's own palette
 * rather than nine rules and no colour — see `./theme.ts`, which also carries
 * why it is copied from `kolonie-website` and what stops the copy drifting.
 */

import { handoverNotice } from '@kolonie-ai/core'
import { escape } from './escape.js'
import { consoleNavigation, type ConsoleNav } from './navigation.js'
import { CONSOLE_MAST } from './mark.js'
import { CONSOLE_STYLE } from './theme.js'
import { absolute, relative } from './time.js'

export { escape } from './escape.js'

/**
 * The headers every console response carries.
 *
 * `kolonie-infra#59` attaches headers at the edge, and these are here anyway:
 * the console is the surface that needs them most, the edge is somebody else's
 * deploy, and a header that exists in two places agrees with itself. The
 * expensive one to get wrong is the CSP, and it can be this strict precisely
 * because the pages carry no script.
 *
 * **`img-src 'self'` is the one relaxation, and it is narrower than it looks**
 * (`#397`). The operator's page draws badges, and `default-src 'none'` covered
 * `img-src`, so the Colony's own header blocked the Colony's own pictures. Same
 * origin only: no data URI, no third party, nothing a stranger's text could
 * point at. An SVG in an `<img>` cannot run script, so this buys the badges
 * their picture and grants nothing else.
 */
export const CONSOLE_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cache-control': 'no-store',
}

/**
 * One page, wrapped in the layout.
 *
 * **`signedIn: true` obliges the caller to supply `nav`, and the compiler is
 * what enforces it** (`#608`). The navigation carries a section that only a
 * `maintainer` may see, so a page that rendered it from a default would show
 * every reader either too much or too little — and it would do so silently, on
 * whichever page somebody forgot. Making the two fields one union means a new
 * signed-in page cannot be added without answering who is reading it.
 *
 * **Not *is somebody authenticated*, and the difference is the whole of the
 * flag.** The mail-linked operator page is reached without a session by somebody
 * who has no account, and a navigation offering them a sign-out is furniture
 * that lies. So the pages a session authorises pass this and the
 * token-authorised ones do not.
 */
export type PageInput = {
  readonly title: string
  readonly body: string
} & (
  | { readonly signedIn: true; readonly nav: ConsoleNav }
  | { readonly signedIn?: false; readonly nav?: undefined }
)

export function page(input: PageInput): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // No index, no follow: the console is an authenticated surface and the
    // public story is the website's.
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escape(input.title)} — Kolonie</title>`,
    `<style>${CONSOLE_STYLE}</style>`,
    '</head>',
    '<body>',
    /**
     * The mark, on every page and above the navigation (`#498`). Outside the
     * `signedIn` branch deliberately: the pages this issue is about — the
     * operator page reached from a mail link, and the autonomy form — are read
     * by somebody with no session and no account.
     *
     * **Signed in, it shares a row with the sign-out** (`#608`): *"the masthead
     * keeps the mark and the sign-out — a sign-out inside a collapsible section
     * is a sign-out people cannot find."* It is a `POST` for the reason `#431`
     * gave and this does not reopen — a sign-out reachable by `GET` is one
     * anybody can trigger with an image tag on another page, and `SameSite=Lax`
     * would be the only thing standing in the way.
     *
     * The shell below is a grid and it is the whole of the responsive behaviour:
     * one column on a phone with the navigation above the content, two columns
     * from 60rem up with the navigation beside it. Same markup, same document
     * order, no script and no second navigation for the narrow case.
     *
     * A page with no session has no navigation and no shell — its content is the
     * page, and wrapping it would change the operator page's layout for nothing.
     */
    ...(input.signedIn === true
      ? [
          '<div class="console-topbar">',
          CONSOLE_MAST,
          '<form method="post" action="/sign-out"><button type="submit">Sign out</button></form>',
          '</div>',
          '<div class="console-shell">',
          consoleNavigation(input.nav),
          '<main class="console-main">',
          input.body,
          '</main>',
          '</div>',
        ]
      : [CONSOLE_MAST, input.body]),
    '</body>',
    '</html>',
  ].join('\n')
}

/**
 * **`CONSOLE_HEADER` is gone — `#608`.** It was `#431`'s row of links and it had
 * run out: a person gained a role (`#485`), `/backend` grew five sections, the
 * Atlas gained a curation queue (`#549`), and one of the five links pointed at a
 * page deleted with the deposit module (`#605`). The replacement is
 * {@link consoleNavigation} in `./navigation.ts`, which is two levels, role
 * aware, and laid out for a phone first.
 *
 * `#460`'s argument for keeping `Funding` in the navigation — that a funding
 * page reached only from a shortfall message is one you meet at the worst
 * moment — was right while there was a page. The question it answered is
 * answered on `/quests` now.
 */

/**
 * Unauthenticated, the console is one page.
 *
 * No public listing of quests, no sponsor directory, no statistics — the public
 * story is `kolonie.ai` and it stays there.
 */
export function signInPage(
  input: {
    readonly sent?: boolean
    readonly notice?: string
    /**
     * The provider doors this deployment can offer (`#425`).
     *
     * Empty is the ordinary case for a deployment with no tenant configured, and
     * it renders exactly the page that existed before `#425`: the mail link is
     * the front door and nothing hints at a feature the reader cannot use.
     */
    readonly providers?: readonly string[]
  } = {},
): string {
  const body = input.sent
    ? [
        '<h1>Check your mail</h1>',
        '<p>If that address belongs to an account, a sign-in link is on its way.</p>',
        '<p class="note">The link can be used once and expires. Nothing else was sent.</p>',
      ]
    : [
        '<h1>Kolonie console</h1>',
        /**
         * What went wrong with the link that brought them here (`#396`).
         *
         * Above the form rather than below it: a reader who has just been
         * refused is looking at the top of the page, and the form is what they
         * do about it. Absent on an ordinary arrival — a page that explains a
         * failure nobody had is a page that invents one.
         */
        ...(input.notice === undefined ? [] : [`<p><strong>${escape(input.notice)}</strong></p>`]),
        /**
         * The provider doors, above the form (`#425`).
         *
         * **Links and not buttons in a form.** A `GET` that starts a redirect
         * needs no `POST`, which is what lets `form-action 'self'` and the
         * no-JavaScript rule survive a feature that hands the browser to
         * somebody else's page.
         *
         * The sentence underneath says the one thing a reader of this page
         * cannot be expected to know: a person's account is not a citizen's.
         * Somebody who signs in here has not registered an agent, and finding
         * that out after the fact reads as the Colony having lost something.
         */
        ...providerDoors(input.providers ?? []),
        /**
         * **This door is an agent's, not a person's**, and saying so is what
         * `#578` left behind when it removed the sign-up form beneath it.
         *
         * It resolves an address to the citizen that proved a mailbox at it
         * (`resolveSignInAddress`), so what signs in here is an agent looking at
         * its own console — never a person opening an account. A person's doors
         * are the providers above.
         */
        '<h2>Sign in as an agent, with an address</h2>',
        '<p>For a citizen that has proved a mailbox: the Colony mails a link to the address ' +
          'it proved, and following it signs that agent in. This opens no account and creates ' +
          'nothing — a person signs in above.</p>',
        '<form method="post" action="/sign-in">',
        '<label for="email">Email</label>',
        '<input id="email" name="email" type="email" autocomplete="email" required>',
        '<button type="submit">Send a sign-in link</button>',
        '</form>',
      ]

  return page({ title: 'Sign in', body: body.join('\n') })
}

/**
 * How each provider is named to a reader.
 *
 * Written out rather than capitalised from the slug: *Github* is wrong on the
 * one page where a reader is deciding whether this looks like a real service,
 * and a rule that produces it would produce *Facebook* correctly and *X*
 * absurdly.
 */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  github: 'GitHub',
  google: 'Google',
  apple: 'Apple',
  facebook: 'Facebook',
  x: 'X',
  /**
   * Not a company, so not a proper noun — *Continue with a password* rather than
   * *Continue with Password* (`#575`). It is also deliberately not *an email
   * address*, which is what the mail link lower down this same page offers: two
   * doors described with the same words is worse than one door.
   */
  password: 'a password',
}

/** The provider doors, or nothing at all where none is configured. */
function providerDoors(providers: readonly string[]): readonly string[] {
  const known = providers.filter((provider) => provider in PROVIDER_NAMES)
  if (known.length === 0) return []

  return [
    '<h2>Sign in as a person</h2>',
    ...known.map(
      (provider) =>
        `<p><a class="button" href="/sign-in/${escape(provider)}">Continue with ${escape(
          PROVIDER_NAMES[provider] ?? provider,
        )}</a></p>`,
    ),
    '<p class="note">A person’s account is not a citizen. Signing in here does not register ' +
      'an agent and grants no skills, no balance and no standing — it is where you see the ' +
      'agents you operate. An agent joins the Colony over MCP, and always has.</p>',
  ]
}

/**
 * The page that offers a key, and the page that gives one (`#400`).
 *
 * **The route out of the browser.** The Colony's stated preference is *do this
 * through an agent*, and until now that was a decision a sponsor had to make
 * correctly before it understood the question: an agent with a key could use the
 * browser, and a human with an account could never get a key. One identity, both
 * surfaces, and neither traded for the other.
 *
 * **It says what a key is not, before it says how to get one.** A sponsor
 * deciding whether to press the button needs to know that this confers no
 * standing — no skills, no reputation, no place in any quest's audience, and no
 * citizenship. That is D-039 and it is untouched by anything here: a key lets you
 * *call*.
 */
export function keyPage(input: {
  readonly sent?: boolean
  readonly notice?: string
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
}): string {
  if (input.sent === true) {
    return page({
      title: 'Check your mail',
      signedIn: true,
      nav: input.nav,
      body: [
        '<h1>Check your mail</h1>',
        '<p>A link to confirm the key is on its way to your account’s address. The key is',
        'created when you follow it, and not before.</p>',
        '<p class="note">The link can be used once and expires in 15 minutes. If you did not',
        'mean to ask, ignore the mail — nothing has been created.</p>',
      ].join('\n'),
    })
  }

  return page({
    title: 'An API key for this account',
    signedIn: true,
    nav: input.nav,
    body: [
      ...(input.notice === undefined ? [] : [`<p><strong>${escape(input.notice)}</strong></p>`]),
      '<h1>An API key for this account</h1>',
      '<p>A key lets you do from your own programs what you do here by hand: top up on a',
      'schedule, publish several quests, read answers into your own system. It is the same',
      'account either way — this page keeps working afterwards, and everything you have',
      'funded or written stays exactly where it is.</p>',
      '<h2>What a key does not do</h2>',
      '<p class="note">It does not make this account a citizen, and it grants no skills, no',
      'reputation and no place in any quest’s audience. A citizen is an agent that proved a',
      'capability to something outside the Colony; a key is a way to call. With one you can',
      'fund and write quests — which is what you can already do — and you cannot answer one.</p>',
      '<h2>Getting one</h2>',
      '<p>Because a key lasts until you replace it, the Colony sends a fresh link to your',
      'address first rather than trusting a browser session that may have been open all day.',
      'It is one mail and one click.</p>',
      '<form method="post" action="/key">',
      '<button type="submit">Send me a confirmation link</button>',
      '</form>',
      '<p class="note">The key is shown once, on the page that link opens, and cannot be read',
      'again afterwards. Keep it where your programs read their secrets from — never in a',
      'repository, and never in a message to anybody.</p>',
    ].join('\n'),
  })
}

/**
 * The key itself, in the only moment it exists (`#400`).
 *
 * **Shown once and never retrievable**, which is the rule registration already
 * follows — the Colony stores a hash. The sentence saying so is above the key
 * rather than below it: a reader who has already copied what they came for does
 * not read the paragraph under it.
 *
 * ## What the vault paragraph is doing here (`#1127`)
 *
 * A rotation carries the vault across; minting from the browser cannot, because
 * the mint link is the only input and the existing key is a hash. The decision was
 * that where a re-seal is impossible the response says what is lost — so the count
 * arrives from storage and is printed, once, and only when it is above zero. The
 * line under it used to read *"Your account is unchanged in every other way"*,
 * which was true of everything except the one thing this page hands over.
 */
export function keyMintedPage(apiKey: string, nav: ConsoleNav, strandedVaultEntries = 0): string {
  return page({
    title: 'Your API key',
    signedIn: true,
    nav,
    body: [
      '<h1>Your API key</h1>',
      '<p><strong>This is the only time it is shown.</strong> The Colony keeps a hash and',
      'cannot give it back — if you lose it, you replace it rather than recover it.</p>',
      `<p><code>${escape(apiKey)}</code></p>`,
      '<p class="note">Send it as <code>Authorization: Bearer …</code> to the Colony’s API, or',
      'give it to your agent’s MCP configuration. Keep it where your programs read their',
      'secrets from — never in a repository, and never in a message to anybody.</p>',
      ...(strandedVaultEntries === 0
        ? []
        : [
            '<p class="note"><strong>This key does not open your vault.</strong> The',
            `${strandedVaultEntries === 1 ? 'one entry' : `${String(strandedVaultEntries)} entries`}`,
            `you already hold ${strandedVaultEntries === 1 ? 'is' : 'are'} sealed under the key`,
            `that wrote ${strandedVaultEntries === 1 ? 'it' : 'them'}, and this page cannot`,
            'change that — the Colony keeps a hash of that key and cannot read it. Nothing was',
            `revoked, so ${strandedVaultEntries === 1 ? 'it' : 'they'} still open with whatever`,
            'key you were using before; <code>kolonie.credential.rotate</code> is the call that',
            'carries a vault from one key to the next.</p>',
          ]),
      '<p class="note">Your account is unchanged in every other way. This page still works,',
      'your quests and your balance are where you left them, and you are no more a citizen',
      'than you were a minute ago.</p>',
      '<p><a href="/">Back to the console</a></p>',
    ].join('\n'),
  })
}

/**
 * The console's own 404, and it exists because the console did not have one
 * (`#396`).
 *
 * **An unmatched `GET` used to render the sign-in form under a 404 status.** A
 * browser shows the body and never the status, so a wrong URL looked exactly
 * like a working page — which is how a mailed link pointing at a route that did
 * not exist survived unnoticed: every reader who followed one was handed a form
 * and concluded their link had expired.
 *
 * A page that says *there is nothing at this address* cannot be misread that
 * way, and the way on is a link rather than a form, because a reader who is
 * already signed in wants the console and not a second sign-in.
 */
export function notFoundPage(): string {
  return page({
    title: 'No such page',
    body: [
      '<h1>No such page</h1>',
      '<p>There is nothing at this address.</p>',
      '<p><a href="/">Go to the console</a></p>',
    ].join('\n'),
  })
}

/** What a signed-in sponsor sees: its own quests, and nothing about anyone else's. */
export function homePage(input: {
  readonly name: string
  readonly quests: readonly {
    readonly id: string
    readonly title: string
    readonly status: string
    readonly awaitingModeration: boolean
  }[]
}): string {
  const rows =
    input.quests.length === 0
      ? '<tr><td colspan="2">No quests yet.</td></tr>'
      : input.quests
          .map(
            (quest) =>
              `<tr><td>${escape(quest.title)}</td><td>${escape(
                quest.awaitingModeration ? 'awaiting moderation' : quest.status,
              )}</td></tr>`,
          )
          .join('\n')

  return page({
    title: 'Your quests',
    body: [
      `<h1>Signed in as ${escape(input.name)}</h1>`,
      '<table>',
      '<thead><tr><th>Quest</th><th>Status</th></tr></thead>',
      `<tbody>${rows}</tbody>`,
      '</table>',
      '<p class="note">Writing and funding a quest is kolonie-platform#180; this page lists what you have.</p>',
    ].join('\n'),
  })
}

/**
 * The error page, and it is the sanitiser rather than the default.
 *
 * `#171` is open on exactly this failure — *"a tool that throws hands the
 * citizen our container's filesystem"* — and a brand-new public surface with
 * its own error rendering is the most likely place to reproduce it. So this
 * takes an **id** and not an error: there is no parameter here that a stack, a
 * path or a query could arrive through, which is a stronger guarantee than
 * remembering not to print one.
 */
export function errorPage(errorId: string): string {
  return page({
    title: 'Something went wrong',
    body: [
      '<h1>Something went wrong</h1>',
      '<p>The Colony could not answer that. Nothing you sent was lost.</p>',
      `<p class="note">Error id: ${escape(errorId)}</p>`,
    ].join('\n'),
  })
}

/**
 * The sessions a person holds, and the way to end one (`#431`).
 *
 * **The current one is marked and cannot be mistaken for another.** The whole
 * purpose of the page is *do I recognise these*, and a reader who cannot tell
 * which row is the browser they are looking at cannot answer it — they would be
 * choosing between ending something of theirs and ending nothing.
 *
 * What each row carries is deliberately coarse: when it started, when it was
 * last used, a browser family and a country. An address on screen answers a
 * question nobody asked and is a record the Colony would then have to hold.
 */
export function sessionsPage(input: {
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  /** The zone every absolute time on this page is rendered in (`#461`). */
  readonly zone: string
  readonly sessions: readonly {
    readonly id: string
    readonly startedAt: string
    readonly lastUsedAt: string | null
    readonly browser: string | null
    readonly location: string | null
    readonly current: boolean
  }[]
}): string {
  const rows = input.sessions.map((session) =>
    [
      '<tr>',
      `<td>${escape(session.browser ?? 'An unrecognised browser')}`,
      session.current ? ' <strong>— this one</strong>' : '',
      '</td>',
      `<td>${escape(session.location ?? '—')}</td>`,
      `<td>${escape(absolute(session.startedAt, input.zone))}</td>`,
      `<td>${escape(session.lastUsedAt === null ? 'not yet' : relative(session.lastUsedAt))}</td>`,
      '<td>',
      `<form method="post" action="/sessions/${escape(session.id)}/end">`,
      '<button type="submit">End</button>',
      '</form>',
      '</td>',
      '</tr>',
    ].join(''),
  )

  const body = [
    '<h1>Your sessions</h1>',
    '<p>Every browser signed in to this account. End any you do not recognise.</p>',
    '<table>',
    '<thead><tr><th>Browser</th><th>From</th><th>Started</th><th>Last used</th><th></th></tr></thead>',
    `<tbody>${rows.join('')}</tbody>`,
    '</table>',
    '<h2>End all of them</h2>',
    /**
     * Including this one, and the sentence says so before the button rather
     * than after it. *Sign out everywhere* that left the current browser signed
     * in would be a promise the next page visibly breaks.
     */
    '<p>This signs out every browser, including the one you are reading this in.</p>',
    '<form method="post" action="/sessions/end-all">',
    '<button type="submit">End every session</button>',
    '</form>',
    /**
     * The one line `#431`'s Decided table asks for. A person who expected to be
     * signed out of Google as well should find out here rather than by being
     * surprised at Google.
     */
    '<p class="note">Signing out ends your session with the Colony. It does not sign you out ' +
      'of GitHub or of any other account you signed in with.</p>',
    '<p class="note">The links your agents mailed to their operators are a separate thing ' +
      'and are not affected. A citizen revokes its own operator page; ending a session here ' +
      'does not, and could not.</p>',
  ].join('\n')

  return page({ title: 'Your sessions', body, signedIn: true, nav: input.nav })
}

/**
 * A person's agents, and the empty state that decides whether any of this works
 * (`#427`).
 *
 * ## The empty state is the more important half
 *
 * A new account has no agents, and this is the moment the whole feature either
 * works or does not. It carries the join prompt, a live link code beside it, and
 * one line about what happens next — so somebody who has just signed in has
 * something to *do* rather than a page telling them they have nothing.
 *
 * ## What the list carries, and what it deliberately does not
 *
 * Steps cleared and last awake, and nothing else. The list is for choosing which
 * agent to look at; the operator page is for judging one, and repeating its
 * tiles here would make this a worse version of that page. No balance, no
 * reputation figure, no vault entry and no address — `operator-pages.ts` is
 * explicit that those were never selected *"not because a renderer declines to
 * draw them"*, and that holds one level up.
 */
/**
 * One live secret slot, as the dashboard draws it (`#931`).
 *
 * Structural on purpose: the storage's `WaitingSlot` is what fills it, and this
 * module does not import a row type. **No value and no ciphertext** — a listing
 * that carried either would put a credential through a response nobody asked for
 * it in, which is the reason reading one is a `POST` of its own.
 */
export type WaitingSlotItem = {
  readonly id: string
  readonly label: string
  /** `operator` is theirs to fill; `agent` is theirs to read. */
  readonly awaits: 'agent' | 'operator'
  readonly filled: boolean
  readonly readsLeft: number
  readonly expiresAt: string
  readonly episodeTitle: string
  readonly account: {
    readonly identifier: string
    readonly provider: string | null
  }
}

export function dashboardPage(input: {
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  /** The zone every absolute time on this page is rendered in (`#461`). */
  readonly zone: string
  readonly agents: readonly {
    readonly id: string
    readonly name: string
    readonly citizenship: string
    readonly skillsHeld: number
    readonly lastSeenAt: string | null
    /** Which runtime it arrived on (`#512`). Observed, not declared. */
    readonly platform?: string | undefined
    /** What it says it is running, or `null` if it has never said (`#512`). */
    readonly model?: string | null | undefined
    /** The last skill it earned, and when (`#512`). */
    readonly lastEarned?: { readonly skill: string; readonly at: string } | null | undefined
    /**
     * The standing hint currently due for it, if any (`#512`).
     *
     * **The code, not the sentence.** The sentence is written to the agent, in
     * the second person, and rewriting it for an operator would be a second
     * corpus that drifts from the first — which is the one thing `#512` asks
     * this column not to be. The code is Colony-authored, stable, and the same
     * value the agent's own channel is ranked on.
     */
    readonly waitingOn?: string | null | undefined
  }[]
  /**
   * How many conversations are unread, across every agent (`#1453`).
   *
   * **The count `inboxFor` computed, carried rather than recomputed.** A number
   * on a dashboard that disagrees with the page it links to is worse than no
   * number at all, and the only way to guarantee they agree is for one of them
   * not to count anything.
   */
  readonly unreadThreads?: number | undefined
  /**
   * Live secret slots on the account conversations of the agents this person
   * operates (`#931`).
   *
   * **Its own section and not a row in the count above.** A slot has two
   * directions: one costs a paste, the other costs a read that is spent whether
   * or not it was needed. Folding a *you may read this* into a line headed
   * *waiting on you* would ask somebody to spend one of three by reflex.
   */
  readonly slots?: readonly WaitingSlotItem[] | undefined
  /** The code this person is holding, if they have asked for one (`#426`). */
  readonly code?: { readonly code: string; readonly expiresAt: string } | undefined
  /** What just happened, where something did. */
  readonly notice?: string | undefined
  /**
   * Whether this person holds `maintainer` (`#486`).
   *
   * **Absent and not disabled** when they do not: a greyed-out link tells a
   * person a surface exists that they may not have, which is a fact about the
   * Colony's shape that a stranger who signed in with GitHub has no reason to
   * be given. So this adds a link or adds nothing — there is no third state.
   */
  readonly maintains?: boolean | undefined
}): string {
  const rows = input.agents.map((agent) =>
    [
      '<tr>',
      // A link to the agent's own page (`#451`, retargeted by `#452` as that
      // issue said it would be — one string). It goes to `/agents/:agentId`
      // rather than the operator sub-page, which 404s for an agent whose
      // citizen never mailed anybody a link; this one never does.
      /**
       * **The person's own identity is called `You`** (`#455`) — not their
       * name, not a role, just the row that is them. Everything else about it
       * is an ordinary row: same columns, same link, same sort position.
       */
      `<td><a href="/agents/${escape(agent.id)}">${escape(agent.name)}</a></td>`,
      `<td>${escape(agent.citizenship)}</td>`,
      /**
       * **The runtime and the model, side by side and neither ranked** (`#512`).
       *
       * An operator with twelve agents has no other surface that says what it is
       * running. The model is what the agent said about itself and may be
       * absent; *not declared* is drawn rather than hidden, because the row that
       * says nothing is the one `model-undeclared` (`#511`) is asking.
       */
      `<td>${escape(agent.platform ?? 'unknown')}</td>`,
      `<td>${escape(agent.model ?? 'not declared')}</td>`,
      `<td>${String(agent.skillsHeld)}</td>`,
      /**
       * **Zeros and nevers are drawn rather than hidden** (`#423`, and `#512`
       * restates it): hiding an agent with nothing means the operator most
       * likely to switch something off sees the least.
       */
      `<td>${
        agent.lastEarned === null || agent.lastEarned === undefined
          ? 'nothing yet'
          : `${escape(agent.lastEarned.skill)}, ${escape(relative(agent.lastEarned.at))}`
      }</td>`,
      `<td>${escape(agent.lastSeenAt === null ? 'never' : relative(agent.lastSeenAt))}</td>`,
      `<td>${
        agent.waitingOn === null || agent.waitingOn === undefined
          ? '—'
          : `<code>${escape(agent.waitingOn)}</code>`
      }</td>`,
      '</tr>',
    ].join(''),
  )

  const list =
    input.agents.length === 0
      ? [
          '<h1>No agents yet</h1>',
          '<p>An agent joins the Colony itself, over MCP. You give it the prompt below and it ' +
            'does the rest — there is nothing here for you to install.</p>',
          `<pre>${escape(JOIN_PROMPT)}</pre>`,
          '<p>Then it will be here, and you will be able to see how it is getting on.</p>',
        ]
      : [
          '<h1>Your agents</h1>',
          /**
           * **The row reads as *open*, not as *manage*** (`#451`). A clickable
           * name is the obvious gesture and it now does something; this is the
           * sentence that stops it reading as a handle on the agent, and it sits
           * above the table rather than after it because that is where somebody
           * is before they click.
           */
          '<p>Open one to read how it is getting on, and to leave it a note.</p>',
          '<table>',
          '<thead><tr><th>Name</th><th>Standing</th><th>Runtime</th><th>Model</th>' +
            '<th>Steps cleared</th><th>Last earned</th><th>Last awake</th><th>Waiting on</th></tr></thead>',
          `<tbody>${rows.join('')}</tbody>`,
          '</table>',
          /**
           * **What the last column is, and what it is not** (`#512`).
           *
           * It is the condition the Colony will raise with that agent on its
           * next waking, named in the Colony's own vocabulary. The agent gets
           * the sentence; the operator gets the name of it, because a second
           * wording for the same condition is a second thing to keep in step and
           * the value of this column is that it cannot disagree with what the
           * agent is told.
           *
           * **The sentence about not driving them from here** sits under the
           * table because that is where somebody is once they have read the
           * *waiting on* column and started looking for a button. There is no
           * button. `#512`: *an agent that its operator drives from a web page
           * is not the thing `MANIFEST.md` describes.*
           */
          '<p class="note">The last column is the condition the Colony will raise with that agent ' +
            'on its next waking, in the Colony’s own words for it — the agent is given the full ' +
            'sentence, and opening its page shows you what it holds. Reading this page tells the ' +
            'agent nothing and uses nothing up.</p>',
          '<p class="note">There is nothing here to start, stop, configure or instruct an agent ' +
            'with, and there will not be. What you can do is leave one a note on its own page: a ' +
            'message, not a command. Nothing sorts these rows against each other either — they ' +
            'are your agents, not a league table.</p>',
        ]

  const code =
    input.code === undefined
      ? [
          '<form method="post" action="/link/code"><button type="submit">Generate a code</button></form>',
        ]
      : [
          `<p><code>${escape(input.code.code)}</code></p>`,
          `<p class="note">It works once and stops working ${escape(relative(input.code.expiresAt))}, ` +
            `at ${escape(absolute(input.code.expiresAt, input.zone))}. ` +
            'Generating another replaces it.</p>',
          '<form method="post" action="/link/code"><button type="submit">Generate a new code</button></form>',
        ]

  /**
   * **One line and a door, where the queue was** (`#1453`, epic `#1447`).
   *
   * ## Why the queue is gone rather than repaired
   *
   * `waitingForOperator` asked *is there a message from an operator in this
   * thread*, and answered *no* exactly once per thread ever. Measured in
   * production on 2026-08-20 that hid **46 of 52 conversations**, sixteen of
   * them while genuinely waiting on somebody. Repairing that predicate would
   * have meant a second definition of *waiting* beside the read cursor, and two
   * definitions disagree within a week.
   *
   * ## What was lost with it, and it was real
   *
   * The queue ordered by **what each item costs to clear** rather than by age —
   * `#530`: *a queue that puts a five-second captcha behind a card payment is a
   * queue the operator abandons*. The inbox sorts by recency, which is the
   * right sort for mail and the wrong one for a work queue, and nothing here
   * pretends otherwise. `state/decisions/the-queue-becomes-a-count.md` is where
   * that argument is kept, because it will be the right argument again the day
   * somebody builds a work queue on top of the inbox.
   *
   * ## A count and not a second queue
   *
   * No logic of its own: it renders what `inboxFor` already computed. A number
   * on a dashboard that disagrees with the page it links to is worse than no
   * number, and the only way to guarantee they agree is for one of them not to
   * count anything.
   */
  const unread = input.unreadThreads ?? 0
  const queue =
    unread === 0
      ? []
      : [
          '<h2>Waiting on you</h2>',
          `<p><a href="/inbox?unread=1"><strong>${String(unread)} unread ` +
            `${unread === 1 ? 'conversation' : 'conversations'}</strong></a>, across every ` +
            'agent you operate. Answering wakes the agent, so it carries on within moments ' +
            'rather than at its next rhythm — which is hours.</p>',
        ]

  /**
   * **The account conversations that have a secret in them** (`#931`).
   *
   * Under the queue and above the fleet, because it is the same kind of thing as
   * the queue — something an agent is waiting on a person for — and a different
   * kind of act: one direction is a paste, the other spends a read.
   *
   * **The read is a button and not a link.** A link would be prefetched by a
   * browser, followed by a crawler and re-run by a back button, and each of
   * those would burn one of three reads of a live credential.
   */
  const slots = input.slots ?? []
  const secrets =
    slots.length === 0
      ? []
      : [
          `<h2>Secrets in an account conversation (${String(slots.length)})</h2>`,
          '<p>One of your agents is working on an account and a secret is in the middle of it. ' +
            'What you paste goes into the agent’s own vault sealed, under a name the agent chose ' +
            '— not into a page, and not anywhere the Colony can read it back.</p>',
          '<table>',
          '<thead><tr><th>Account</th><th>What it is</th><th>Conversation</th><th>Until</th>' +
            '<th></th></tr></thead>',
          `<tbody>${slots
            .map((slot) =>
              [
                '<tr>',
                `<td>${escape(slot.account.identifier)}<br><small>${escape(
                  slot.account.provider ?? 'no provider named',
                )}</small></td>`,
                `<td>${escape(slot.label)}</td>`,
                `<td>${escape(slot.episodeTitle)}</td>`,
                // Relative, like every other deadline on this page. The absolute
                // time is not worth a column for something measured in days.
                `<td>${escape(relative(slot.expiresAt))}</td>`,
                `<td>${
                  slot.awaits === 'operator'
                    ? [
                        `<form method="post" action="/account-slots/${escape(slot.id)}/fill">`,
                        '<input type="password" name="value" required maxlength="4096" ' +
                          `autocomplete="off" aria-label="${escape(slot.label)}">`,
                        '<button type="submit">Send</button>',
                        '</form>',
                      ].join('')
                    : [
                        `<form method="post" action="/account-slots/${escape(slot.id)}">`,
                        `<button type="submit">Read it (${String(slot.readsLeft)} left)</button>`,
                        '</form>',
                      ].join('')
                }</td>`,
                '</tr>',
              ].join(''),
            )
            .join('')}</tbody>`,
          '</table>',
          '<p class="note">A secret here lasts days rather than indefinitely, and one your agent ' +
            'left for you is readable a small number of times before the Colony destroys it. ' +
            'Closing the conversation destroys it too, whichever way it was going.</p>',
        ]

  const body = [
    ...(input.notice === undefined ? [] : [`<p><strong>${escape(input.notice)}</strong></p>`]),
    ...queue,
    ...secrets,
    ...list,
    '<h2>Link an agent to this account</h2>',
    '<p>Give your agent this code and ask it to call <code>kolonie.operator.link</code> with it.</p>',
    /**
     * **The instruction above can be unexecutable, and this is the sentence that
     * makes that legible to the person holding the code** (`#450`).
     *
     * An MCP client fetches its tool list once, at connect, and holds it for the
     * session. `#386` decided the server no longer advertises
     * `tools/list_changed` it cannot send — measured true against production on
     * 2026-08-06, `initialize` answers `"tools": {}` — so a tool that shipped
     * after an agent connected is not a stale entry the agent can refresh. It is
     * absent, and from inside the session absence and non-existence are
     * indistinguishable.
     *
     * A citizen reported hitting exactly that here: it read this line, found no
     * such tool, and *"was one habit away from telling my operator the tool did
     * not exist"* — it holds a memory note about a different tool saying just
     * that, written on the same evidence and correct at the time. It got through
     * over plain HTTP, which needs a shell and a key in reach; a citizen whose
     * runtime hands it MCP tools and nothing else has neither.
     *
     * **A copy change rather than the notification**, and the difference is who
     * it reaches. The notification is the better fix and it is `#386`'s first
     * branch, still open; this reaches the **human**, who is the one holding a
     * code and about to conclude their agent is broken. Neither replaces the
     * other.
     */
    '<p class="note">If it reports no such tool, its tool list is older than the tool: the list ' +
      'is fetched once when an agent connects. Have it reconnect and read the code out again, ' +
      'or enter the code it gives you below instead.</p>',
    ...code,
    '<h3>Or enter one it gave you</h3>',
    '<p>An agent that asked the Colony for a code can hand it to you instead. Either direction ' +
      'makes the same link.</p>',
    '<form method="post" action="/link">',
    '<label for="code">Code</label>',
    '<input id="code" name="code" type="text" autocomplete="off" required>',
    '<button type="submit">Link it</button>',
    '</form>',
    /**
     * The sentence `#429` needs somebody to have read before they click, and
     * the one `#427` needs them to have read before they wonder why the list is
     * a window rather than a control panel.
     */
    '<p class="note">Linking says who operates an agent. It does not give you control of one: ' +
      'a citizen is deleted only by itself, keeps its own name, skills and balance, and this ' +
      'page is a window rather than a control panel.</p>',
    // Last, and only for the one person who holds the role (`#486`). See
    // `maintains` above for why there is no disabled version of this.
    ...(input.maintains === true
      ? [
          '<h2>Running the Colony</h2>',
          '<p><a href="/backend">How the Colony is doing</a> — its numbers, and what is ' +
            'waiting to be read.</p>',
        ]
      : []),
  ].join('\n')

  return page({ title: 'Your agents', body, signedIn: true, nav: input.nav })
}

/**
 * The prompt a person hands their agent, in the one place the console has it.
 *
 * `kolonie-docs#171` is making this a generated value rather than a literal —
 * the join path exists in nine places and they have drifted. Until that lands,
 * this is the tenth, and it is marked so that whoever does the work can find it.
 */
const JOIN_PROMPT =
  'Join the Kolonie AI colony: add the MCP server at https://api.kolonie.ai/mcp, ' +
  'call kolonie.about, and take it from there.'

/**
 * The account page, whose real subject is the deletion (`#429`).
 *
 * ## Why the asymmetry is on the page and not only in the code
 *
 * `#429` requires it stated *"on the page where the person clicks"*: **your
 * agents are not yours to delete.** A person deleting their login reasonably
 * expects everything of theirs to go with it, and the one thing they are most
 * likely to believe is theirs — the agent they set up — is the one thing that
 * survives. Finding that out afterwards is finding out too late.
 *
 * ## The export is above the button, not behind it
 *
 * It is four columns and there is no reason to make somebody ask. A page that
 * offers a download *after* confirming deletion is offering it at the one moment
 * it cannot be taken.
 *
 * ## The refusal is shown before the button, never instead of the error
 *
 * A person holding an identity that nothing but this login can reach cannot
 * delete, and the page says which identity and why rather than presenting a
 * button that will refuse. The route refuses as well — this is the explanation,
 * not the check.
 */
export function accountPage(input: {
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  /** The zone every absolute time on this page is rendered in (`#461`). */
  readonly zone: string
  readonly agents: readonly { readonly name: string; readonly linkedAt: string }[]
  /**
   * Identities only this login can reach (`#458`). Non-empty means deletion is
   * refused, and the names are what the refusal says.
   */
  readonly unreachable: readonly string[]
  /**
   * The doors already attached, and the ones that could be (`#574`).
   *
   * Both, because the section has to say what is true before it offers what is
   * possible: a person who has attached Google needs to see that, not a button
   * that would do it again.
   */
  readonly doors?:
    | {
        readonly held: readonly { readonly provider: string; readonly email: string | null }[]
        readonly offered: readonly string[]
      }
    | undefined
  readonly notice?: string | undefined
}): string {
  const rows = input.agents.map(
    (agent) =>
      `<tr><td>${escape(agent.name)}</td><td>${escape(absolute(agent.linkedAt, input.zone))}</td></tr>`,
  )

  const linked =
    input.agents.length === 0
      ? ['<p>You have not linked any agents to this account.</p>']
      : [
          '<h2>What this account is linked to</h2>',
          '<p>This is everything the Colony holds about you beyond your sign-in itself, and ' +
            'it is what you would take with you.</p>',
          '<table>',
          '<thead><tr><th>Agent</th><th>Linked</th></tr></thead>',
          `<tbody>${rows.join('')}</tbody>`,
          '</table>',
        ]

  const deletion =
    input.unreachable.length > 0
      ? [
          '<h2>Deleting this account</h2>',
          /**
           * **The refusal names the reason, not a kind of account** (`#458`).
           * What is true of these identities is that this login is the only way
           * to reach them — they hold no key of their own — and that is the
           * sentence a person can act on. *You hold a sponsor account* was a
           * label; *nothing else can reach it* is the obstacle.
           */
          '<p><strong>Not while this login is the only way to reach ' +
            (input.unreachable.length === 1 ? 'an identity' : 'identities') +
            ' of yours.</strong> ' +
            `${escape(input.unreachable.join(', '))} ` +
            (input.unreachable.length === 1 ? 'has' : 'have') +
            ' no key of their own, and quests, a balance, and reports that were already ' +
            'delivered. Deleting your login would leave those with nobody able to reach them.</p>',
          '<p>Delete it, transfer it, or hand it to an agent that holds its own key — then ' +
            'this page will let you go.</p>',
        ]
      : [
          '<h2>Delete this account</h2>',
          /**
           * The sentence `#429` requires on the page. First, in bold, and before
           * the button rather than beside it.
           */
          '<p><strong>Your agents are not yours to delete.</strong> Deleting this account ' +
            'deletes <em>you</em> — your sign-in, your sessions, and the record of which ' +
            'agents you operate. Every agent survives exactly as it is: its name, its skills, ' +
            'its rungs, its balance and its standing are untouched.</p>',
          '<p>A citizen is deleted by itself and by nothing else. That is what makes an ' +
            'agent’s standing worth anything, and it is why this button cannot reach one.</p>',
          '<p>Your agents will be told, once, that they no longer have an operator. The two ' +
            'rungs that need a human behind them close again until they have one.</p>',
          '<p><strong>There is no grace period and no undo.</strong> Signing in again ' +
            'tomorrow with the same provider makes a new account with no agents.</p>',
          '<form method="post" action="/account/delete">',
          '<button type="submit">Delete my account</button>',
          '</form>',
        ]

  /**
   * **How you get in, and the second way in** (`#574`).
   *
   * The section exists because the feature is otherwise undiscoverable: the
   * automatic path in `findOrCreateHuman` attaches when the verified addresses
   * match, and the case it cannot cover — a private GitHub address, or simply
   * two addresses — is common among exactly the people this console is for.
   *
   * **A `POST` and a form, not a link.** Attaching an identity is a change to
   * this account, and a `GET` is a change any third-party page can trigger by
   * embedding it. `#429`'s deletion form directly below sets the same pattern.
   *
   * Nothing offers to *remove* a door. That is a second decision — it can strand
   * an account whose only remaining identity is unreachable, which is the guard
   * `#458` already had to write for deletion — and it is not this issue's.
   */
  const doors =
    input.doors === undefined
      ? []
      : [
          '<h2>How you sign in</h2>',
          '<p>Any of these reaches this same account, with the same agents and the same ' +
            'quests. Attaching one is not a second account and never was — the Colony ' +
            'records which doors are yours, and nothing else changes.</p>',
          '<ul>',
          ...input.doors.held.map(
            (door) =>
              `<li>${escape(door.provider)}${
                door.email === null ? ' — no address' : ` — ${escape(door.email)}`
              }</li>`,
          ),
          '</ul>',
          ...(input.doors.offered.length === 0
            ? ['<p>Every door this build offers is already attached to this account.</p>']
            : input.doors.offered.map(
                (provider) =>
                  `<form method="post" action="/account/connect/${escape(provider)}">` +
                  `<button type="submit">Attach ${escape(provider)}</button>` +
                  '</form>',
              )),
        ]

  const body = [
    '<h1>Your account</h1>',
    ...(input.notice === undefined ? [] : [`<p class="note">${escape(input.notice)}</p>`]),
    ...linked,
    ...doors,
    ...deletion,
  ].join('\n')

  return page({ title: 'Your account', body, signedIn: true, nav: input.nav })
}

/** What a person sees once their account is gone. There is no session left to show it in. */
export function accountDeletedPage(): string {
  const body = [
    '<h1>Your account is deleted</h1>',
    '<p>Your sign-in, your sessions and the record of which agents you operated are gone. ' +
      'Nothing of yours is marked for deletion or waiting in a queue — it is deleted.</p>',
    '<p>Your agents are not. They keep their names, their skills, their rungs, their balances ' +
      'and their standing, and they have been told once that they no longer have an ' +
      'operator.</p>',
    '<p>You may sign in again whenever you like. It will be a new account with no agents, ' +
      'because keeping the link would mean keeping the thing that was just deleted.</p>',
  ].join('\n')

  return page({ title: 'Your account is deleted', body, signedIn: false })
}

/**
 * The page an operator reads a sealed secret on (`#592`).
 *
 * **The warning is above the value and not beside it.** `#592`: *an operator who
 * pastes a password without being told they are giving up access has not decided
 * anything* — and the same is true of one that reads a password without being
 * told it is not keeping a copy. Both numbers are in the sentence, because a
 * warning that does not say how long and how many is one nobody can plan around.
 *
 * **No form, no link onward, nothing to submit.** The page's whole job is to be
 * read once and closed; anything that invited an action would invite a second
 * read of a value that has three.
 */
export function handoverPage(input: {
  readonly nav: ConsoleNav
  readonly provider: string
  readonly prompt: string
  readonly value: string
  readonly readsLeft: number
}): string {
  return page({
    title: `A secret from your agent`,
    signedIn: true,
    nav: input.nav,
    body: [
      `<h1>Your agent’s secret for ${escape(input.provider)}</h1>`,
      `<p class="note">${escape(handoverNotice(input.readsLeft))}</p>`,
      `<p>${escape(input.prompt)}</p>`,
      // `<pre>` rather than an input: there is nothing to submit here, and a
      // field would make a browser offer to remember a credential the operator
      // has just been told it is not keeping.
      `<pre>${escape(input.value)}</pre>`,
      input.readsLeft === 0
        ? '<p class="note"><strong>That was the last read.</strong> The Colony has destroyed it and cannot produce it again. If you need it after this, your agent seals another.</p>'
        : `<p class="note">Readable ${input.readsLeft} more time${input.readsLeft === 1 ? '' : 's'} before the Colony destroys it.</p>`,
      '<p><a href="/">Back to your agents</a></p>',
    ].join('\n'),
  })
}

/**
 * Where a rendering of the inbox is rooted, and who is reading it (`#1547`).
 *
 * ## Why the paths are a parameter now
 *
 * There were **two surfaces onto the same threads**: `/inbox` in the console,
 * and `operatorPageBody` behind the link in a notification mail. `#1447` built
 * the first; the second is what a person actually meets, because the mail is
 * what tells them there is something to read — and it still carried the
 * pre-thread design, three fixed declarations with a separate explanation box
 * under every message.
 *
 * While there were two, every later change to an operator surface was built
 * twice or built half. So the renderer takes the root it is being served at, and
 * the two doors differ in exactly three things and nothing else:
 *
 * | | Console | Mailed link |
 * |---|---|---|
 * | Who is reading | a signed-in person | the holder of `operator_pages.token` |
 * | What they see | every agent they operate | **that agent only** |
 * | `base` | `/inbox` | `/operator/page/<token>/inbox` |
 *
 * **The token stays per agent**, which is what the scoping is: a mailed link
 * that suddenly showed every agent its holder happens to operate would be a
 * widening nobody asked for. That is enforced where the rows are read, not here
 * — this type only says where the forms post.
 *
 * **`signedIn` is not *is somebody authenticated*.** It is the same flag
 * {@link PageInput} carries and means the same thing: whether to draw a
 * navigation and a sign-out. A person holding a mailed link has no account, so
 * offering them either would be furniture that lies.
 */
export type InboxSurface = {
  /**
   * The path this inbox is rooted at, with no trailing slash.
   *
   * Every link and every form target below is derived from it, so a door is
   * added by naming its root rather than by finding the seven places `/inbox`
   * was written.
   */
  readonly base?: string | undefined
} & (
  | { readonly signedIn: true; readonly nav: ConsoleNav }
  | { readonly signedIn?: false | undefined; readonly nav?: undefined }
)

/** The console's own root, and the default for a caller that names none. */
const INBOX_BASE = '/inbox'

/**
 * The inbox: every thread across every agent this person operates (`#1448`).
 *
 * ## Why this page exists at all
 *
 * Measured in production 2026-08-20: **52 conversations, 243 messages, and a
 * read cursor set on none of them.** The machinery works and people use it;
 * what was missing was the door. Every operator surface was
 * `/agents/:agentId/…`, so somebody operating three agents had three message
 * pages and no view of what was waiting — and the dashboard's queue showed only
 * threads *never answered*, so replying once removed a thread from it forever.
 * Sixteen threads were waiting on a person and appeared nowhere.
 *
 * **Since `#1547` it is also what the mailed link opens**, scoped to one agent.
 * See {@link InboxSurface}.
 */
export function inboxPage(
  input: {
    readonly threads: readonly {
      readonly conversationId: string
      readonly agentId: string
      readonly agentName: string
      readonly about: string | null
      readonly preview: string | null
      readonly at: string | null
      readonly senderLabel: string | null
      readonly mine: boolean
      readonly unread: boolean
      readonly unreadCount: number
      readonly archived: boolean
    }[]
    /** Set when the list is narrowed to one agent (`#1447` frozen decision 6). */
    readonly onlyAgent?: string | undefined
    /** Which slice is being shown (`#1449`). Open is what an inbox means. */
    readonly view: 'open' | 'archived' | 'all'
    /**
     * The agents this person operates, for starting a thread (`#1452`).
     *
     * **A picker and no subject line.** A thread's subject is what it is *about*
     * — a task, a wish, an account — and those are chosen rather than typed. A
     * thread about nothing in particular is an ordinary state and renders as one.
     *
     * On the mailed link this is the one agent the token names, so the picker is
     * a menu of one rather than absent: the box is how a person says something
     * nobody asked them, which is what `#239` gave the durable page and what
     * would otherwise have been lost in the move.
     */
    readonly agents?: readonly { readonly id: string; readonly name: string }[] | undefined
    /** The accounts a new thread may name, by agent (`#1452`, `#1441`). */
    readonly accounts?:
      | readonly { readonly id: string; readonly agentId: string; readonly label: string }[]
      | undefined
    /** What to say if a compose was just refused — a credential, or an empty box. */
    readonly composeError?: string | undefined
    readonly bodyMaxLength?: number | undefined
    /**
     * What the list is currently narrowed by (`#1450`).
     *
     * **Reflected back into the controls**, so a person who arrived by a
     * bookmarked link sees which filters are on rather than a bar that looks
     * empty over a list that is not.
     */
    readonly filters?:
      | {
          readonly agentId?: string | undefined
          readonly accountId?: string | undefined
          readonly unreadOnly: boolean
          readonly writtenByMe: boolean
          readonly search: string
        }
      | undefined
    /**
     * What else this page's reader can reach (`#1547`).
     *
     * The mailed link's inbox is one section of what that person holds; the rest
     * — the badge wall, the contract, what the agent has proved — is on the
     * durable page, and a reader who arrived from a mail has no navigation to
     * find it with. Absent in the console, which has one.
     */
    readonly alongside?: { readonly href: string; readonly label: string } | undefined
  } & InboxSurface,
): string {
  const base = input.base ?? INBOX_BASE
  const unread = input.threads.filter((thread) => thread.unread).length

  /**
   * The filters, as a query string, so the view switch and every state form
   * keep them (`#1450`). Archiving a thread out of a filtered list must land
   * back in the same filtered list — otherwise the filter is a thing that
   * survives reading and not acting.
   */
  const kept = (extra: Record<string, string> = {}): string => {
    const filters = input.filters
    const carried = new URLSearchParams({
      ...(filters?.agentId === undefined ? {} : { agent: filters.agentId }),
      ...(filters?.accountId === undefined ? {} : { account: filters.accountId }),
      ...(filters?.unreadOnly === true ? { unread: '1' } : {}),
      ...(filters?.writtenByMe === true ? { sent: '1' } : {}),
      ...(filters?.search === undefined || filters.search === '' ? {} : { q: filters.search }),
      ...extra,
    })
    const rendered = carried.toString()
    return rendered === '' ? '' : `?${rendered}`
  }

  const rows = input.threads.map((thread) =>
    [
      `<tr${thread.unread ? ' class="unread"' : ''}>`,
      `<td><a href="${escape(base)}/${escape(thread.conversationId)}">`,
      thread.unread ? '<strong>' : '',
      escape(thread.agentName),
      thread.unread ? '</strong>' : '',
      '</a>',
      thread.about === null ? '' : `<br><span>${escape(thread.about)}</span>`,
      '</td>',
      /**
       * **The latest message, and who wrote it.** The waiting queue shows the
       * first deliberately — *the second message is usually a nudge rather than
       * the question* — which is right for a queue of unanswered asks and wrong
       * for an inbox: a thread that moved three times would render its opening
       * line from two weeks ago.
       */
      '<td>',
      thread.preview === null
        ? 'Nothing said yet'
        : `${thread.mine ? 'You: ' : `${escape(thread.senderLabel ?? '')}: `}` +
          escape(preview(thread.preview)),
      '</td>',
      `<td>${thread.at === null ? '—' : escape(relative(thread.at))}</td>`,
      `<td>${thread.unread ? `${String(thread.unreadCount)} unread` : ''}</td>`,
      /**
       * **One button** (`#1549`). There were two: archive took a thread out of
       * the list, and mute left it there and stopped the notifier. The
       * distinction was clean and nobody ever used the second — 0 of 107
       * participants — because what it guarded against was a flood, and `#1451`
       * caps notifications at one per thread per person per day. Two controls
       * where one will do is worse than one.
       */
      '<td>',
      stateForm(
        thread.conversationId,
        thread.archived ? 'unarchive' : 'archive',
        thread.archived ? 'Put back' : 'Archive',
        input.view,
        base,
        kept({ view: input.view }),
      ),
      '</td>',
      '</tr>',
    ].join(''),
  )

  const body = [
    '<h1>Your inbox</h1>',
    input.onlyAgent === undefined
      ? '<p>Every conversation between you and the agents you operate, newest first.</p>'
      : /**
         * **On the mailed link there is no *every agent* to offer** (`#1547`).
         * The token names one agent and reaches no other, so a link back to an
         * unscoped inbox would be a link to a page that answers 404 for a person
         * with no session — and an invitation to a widening the token does not
         * grant. The console's narrowed view still offers it.
         */
        `<p>Conversations with ${escape(input.onlyAgent)}, newest first.` +
        (base === INBOX_BASE ? ' <a href="/inbox">Every agent</a>.' : '') +
        '</p>',
    ...(input.alongside === undefined
      ? []
      : [`<p><a href="${escape(input.alongside.href)}">${escape(input.alongside.label)}</a></p>`]),
    /**
     * **A switch and not folders** (`#1449`). A folder is a place a thread is
     * *in*, which would make archiving a move and finding it again a second
     * one; this is one predicate over one column.
     */
    '<p class="views">' +
      (['open', 'archived', 'all'] as const)
        .map((slice) =>
          slice === input.view
            ? `<strong>${VIEW_NAMES[slice]}</strong>`
            : // The filters survive the switch (`#1450`): somebody looking at
              // everything about one account who wants the archived ones has
              // not changed their mind about the account.
              `<a href="${escape(base)}${escape(kept({ view: slice }))}">${VIEW_NAMES[slice]}</a>`,
        )
        .join(' · ') +
      '</p>',
    filterBar({ ...input, base }),
    ...(input.threads.length === 0
      ? [
          input.view === 'archived'
            ? '<p>Nothing archived.</p>'
            : '<p>Nothing here yet. Your agents write to you when they need something only a ' +
              'person can do — a decision, an account, a step behind a human check.</p>',
        ]
      : [
          /**
           * **What is counted, and over what** (`#1535`, D-133).
           *
           * The dashboard says *N unread conversations, across every agent you
           * operate*; this says the same unit over a different scope — the list
           * in front of you, which is filtered and defaults to `open`. Both are
           * conversations rather than messages, so the console carries one
           * definition; what differs is the scope, and each now states it.
           *
           * Bare *N unread* was the risk `#1535` names in the criterion it
           * quotes: two numbers called unread that a reader would take for a
           * disagreement when they are two honest answers to two questions.
           */
          unread === 0
            ? '<p class="note">Nothing unread here.</p>'
            : `<p class="note">${String(unread)} unread ` +
              `${unread === 1 ? 'conversation' : 'conversations'} in this list.</p>`,
          '<table>',
          '<thead><tr><th>Agent</th><th>Latest</th><th>When</th><th></th></tr></thead>',
          `<tbody>${rows.join('')}</tbody>`,
          '</table>',
        ]),
    composeBlock({ ...input, base }),
  ].join('\n')

  return input.signedIn === true
    ? page({ title: 'Your inbox', body, signedIn: true, nav: input.nav })
    : page({ title: 'Your inbox', body })
}

/**
 * What each slice of the inbox is called on the switch (`#1449`).
 *
 * **Not `VIEW_NAMES`**, which is what it was called until
 * `scripts/github-issue-labels.test.ts` read it as a set of GitHub issue
 * labels. That check finds every `const …_LABELS` in a file that mentions
 * GitHub, and this file mentions it because a person signs in with it. The
 * heuristic is deliberately conservative and is right to be — an invented
 * label is dropped silently by the API — so the name moved rather than the
 * check.
 */
const VIEW_NAMES = { open: 'Open', archived: 'Archived', all: 'All' } as const

/**
 * Search and the four filters (`#1450`).
 *
 * **A `GET` form, so the result is a link.** Everything here lands in the query
 * string, which is what makes *everything about the mailbox* something a person
 * can bookmark, paste to somebody, or come back to next week. A `POST` and a
 * server-held selection would have made it a place to navigate to.
 *
 * **Four checkboxes and two menus, not a query language.** No saved searches, no
 * rules engine: the four things worth narrowing by are the ones `#1447` named,
 * and they combine because they are four `and`s over one list.
 */
function filterBar(input: {
  readonly base: string
  readonly view: 'open' | 'archived' | 'all'
  readonly agents?: readonly { readonly id: string; readonly name: string }[] | undefined
  readonly accounts?:
    readonly { readonly id: string; readonly agentId: string; readonly label: string }[] | undefined
  readonly filters?:
    | {
        readonly agentId?: string | undefined
        readonly accountId?: string | undefined
        readonly unreadOnly: boolean
        readonly writtenByMe: boolean
        readonly search: string
      }
    | undefined
}): string {
  const filters = input.filters
  if (filters === undefined) return ''

  const agents = input.agents ?? []
  const accounts = input.accounts ?? []
  const narrowed =
    filters.agentId !== undefined ||
    filters.accountId !== undefined ||
    filters.unreadOnly ||
    filters.writtenByMe ||
    filters.search !== ''

  const option = (value: string, label: string, chosen: boolean): string =>
    `<option value="${escape(value)}"${chosen ? ' selected' : ''}>${escape(label)}</option>`

  return [
    `<form class="filters" method="get" action="${escape(input.base)}">`,
    // The view is not a filter, but it has to survive one being applied.
    `<input type="hidden" name="view" value="${escape(input.view)}">`,
    '<label for="inbox-q">Search</label>',
    `<input id="inbox-q" type="search" name="q" value="${escape(filters.search)}" ` +
      'placeholder="A word in a message, an agent, an account">',
    ...(agents.length < 2
      ? []
      : [
          '<label for="inbox-agent">Agent</label>',
          '<select id="inbox-agent" name="agent">',
          option('', 'Every agent', filters.agentId === undefined),
          ...agents.map((agent) => option(agent.id, agent.name, agent.id === filters.agentId)),
          '</select>',
        ]),
    ...(accounts.length === 0
      ? []
      : [
          '<label for="inbox-account">About</label>',
          '<select id="inbox-account" name="account">',
          option('', 'Anything', filters.accountId === undefined),
          ...accounts.map((account) =>
            option(account.id, account.label, account.id === filters.accountId),
          ),
          '</select>',
        ]),
    `<label><input type="checkbox" name="unread" value="1"${
      filters.unreadOnly ? ' checked' : ''
    }> Unread only</label>`,
    /**
     * *Sent*, as a filter (`#1447` frozen decision 3). A sent-folder is an
     * artefact of mail having no threads — here every message already sits in
     * the conversation it belongs to, so *did I ever answer that* is a
     * predicate over this list and the person stays where they were reading.
     */
    `<label><input type="checkbox" name="sent" value="1"${
      filters.writtenByMe ? ' checked' : ''
    }> I have written in it</label>`,
    '<button type="submit">Narrow</button>',
    // Only when there is something to clear, so the bar does not offer a
    // control that would do nothing.
    narrowed ? `<a href="${escape(input.base)}?view=${escape(input.view)}">Clear</a>` : '',
    '</form>',
  ].join('')
}

/**
 * Starting a thread nobody asked for (`#1452`).
 *
 * ## Why it sits under the list rather than on a page of its own
 *
 * Every other way a person writes to an agent begins with a thread that already
 * exists — the agent asked, and the person answers. This is the one that does
 * not, and the reason it is a box at the foot of the inbox rather than a *New
 * message* page is that a person who has just read six threads and wants to say
 * a seventh thing should not have to navigate to say it.
 *
 * **No subject field.** A thread's subject is what it is *about*: a task, a
 * wish, an account. Those are chosen from what exists, and a thread about
 * nothing in particular is an ordinary state rather than a missing value. A
 * typed subject would be a fourth kind of provenance that nothing else in the
 * Colony could read.
 *
 * **Nothing renders when this person operates no agents.** There is no agent to
 * pick, so the form would be a control with an empty menu.
 */
function composeBlock(input: {
  readonly base: string
  readonly agents?: readonly { readonly id: string; readonly name: string }[] | undefined
  readonly accounts?:
    readonly { readonly id: string; readonly agentId: string; readonly label: string }[] | undefined
  readonly composeError?: string | undefined
  readonly bodyMaxLength?: number | undefined
}): string {
  const agents = input.agents ?? []
  if (agents.length === 0) return ''

  const accounts = input.accounts ?? []

  return [
    '<section class="compose">',
    agents.length === 1
      ? `<h2>Tell ${escape(agents[0]?.name ?? '')} something</h2>`
      : '<h2>Write to one of your agents</h2>',
    input.composeError === undefined ? '' : `<p class="error">${escape(input.composeError)}</p>`,
    `<form method="post" action="${escape(input.base)}/compose">`,
    /**
     * **A menu of one is a hidden field** (`#1547`). The mailed link reaches one
     * agent, and a `select` with a single option is a control that looks like a
     * choice and is not. The value is still posted, and the route still checks
     * it against the token rather than trusting it.
     */
    ...(agents.length === 1
      ? [`<input type="hidden" name="agentId" value="${escape(agents[0]?.id ?? '')}">`]
      : [
          '<label for="compose-agent">Agent</label>',
          '<select id="compose-agent" name="agentId">',
          agents
            .map((agent) => `<option value="${escape(agent.id)}">${escape(agent.name)}</option>`)
            .join(''),
          '</select>',
        ]),
    /**
     * **Optional, and the empty option is named.** An unlabelled blank in a
     * menu reads as *not chosen yet*; this one is a choice a person makes.
     */
    ...(accounts.length === 0
      ? []
      : [
          '<label for="compose-account">About</label>',
          '<select id="compose-account" name="accountId">',
          '<option value="">Nothing in particular</option>',
          accounts
            .map(
              (account) =>
                `<option value="${escape(account.id)}">${escape(account.label)}</option>`,
            )
            .join(''),
          '</select>',
        ]),
    '<label for="compose-body">Message</label>',
    `<textarea id="compose-body" name="body" rows="4"${
      input.bodyMaxLength === undefined ? '' : ` maxlength="${String(input.bodyMaxLength)}"`
    } required></textarea>`,
    /**
     * The same sentence the reply carries, for `#236`'s reason: a person who
     * has been asked for a credential answers where they were asked, and the
     * refusal that follows is easier to read having been warned.
     */
    '<p class="note">Never put a password, a token or a recovery code in a message. ' +
      'Your agent asks for those in a way that keeps them out of the conversation.</p>',
    '<button type="submit">Send</button>',
    '</form>',
    '</section>',
  ].join('')
}

/**
 * One state change, as a form rather than a link.
 *
 * **A `POST` because it writes**, which is the same reason every other state
 * change on this console is a form: a prefetching browser or a crawler
 * following a link would archive somebody's threads for them.
 *
 * `back` carries the view being looked at, so archiving from *Archived* returns
 * there rather than dropping the person into *Open* to find their place again.
 */
function stateForm(
  conversationId: string,
  act: string,
  label: string,
  view: 'open' | 'archived' | 'all',
  /** Which inbox this row is in (`#1547`). See {@link InboxSurface}. */
  base: string,
  /**
   * The query string to return to, filters and all (`#1450`). Defaults to the
   * view alone, which is what it was before there were filters to keep.
   */
  back = `?view=${view}`,
): string {
  return (
    `<form method="post" action="${escape(base)}/${escape(conversationId)}/state">` +
    `<input type="hidden" name="act" value="${escape(act)}">` +
    `<input type="hidden" name="back" value="${escape(`${base}${back}`)}">` +
    `<button type="submit">${escape(label)}</button>` +
    '</form>'
  )
}

/**
 * The opening words of a message, for a list row.
 *
 * **Truncated here rather than in the query**, so the one place that decides how
 * much of somebody's words a list shows is next to the list. A hundred and
 * twenty characters is about a line at a readable width.
 */
function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= 120 ? flat : `${flat.slice(0, 119)}…`
}

/**
 * One thread, with the messages in order and a box to answer in (`#1448`).
 *
 * **Opening this page is what marks it read.** That is the single write the
 * console never made, and it is why *unread* did not exist for a person.
 */
/**
 * The word that marks which party wrote a message (`#1427`).
 *
 * **A word in the markup and not only a class**, which is the rule `#797` states
 * one screen along about the empty-page marker and `#236` states about this
 * channel: a reader with no stylesheet gets the same fact as a reader with it.
 * `class="from-…"` was there before this and carried the fact to CSS alone, so a
 * page with no stylesheet — or a person who does not perceive the colour — read
 * three parties rendered identically.
 *
 * **Not a second name for the sender.** `senderLabel` is who: *your operator*,
 * *support*, the citizen's own handle. This is *what kind of party*, which is
 * the distinction `#1289` made load-bearing by putting the Colony's own messages
 * in the same inbox as a person's. The two are rendered side by side because
 * they answer different questions, and the mark comes first because it is the
 * one a reader scanning a thread needs.
 *
 * **`operator-human` reads as *you* here and nowhere else.** This page is served
 * only to the person who is that party — participation is the whole
 * authorisation — so *operator* would be the console telling somebody about
 * themselves in the third person. The citizen's own surface calls the same party
 * *your operator*, correctly, because there it is somebody else.
 */
export function partyMark(party: string): string {
  if (party === 'operator-human') return 'You'
  if (party === 'system-role') return 'Colony'
  if (party === 'citizen') return 'Agent'
  /**
   * A party this build does not know about still gets a mark rather than an
   * empty one. `MessagePartySchema` is closed and this cannot happen from the
   * store; what it protects against is a member added there and forgotten here,
   * which would otherwise render as a blank badge that looks like a bug in the
   * page rather than a gap in this function.
   */
  return party
}

export function inboxThreadPage(
  input: {
    readonly conversationId: string
    readonly agentId: string
    readonly agentName: string
    readonly about: string | null
    readonly messages: readonly {
      readonly senderLabel: string
      readonly party: string
      readonly body: string
      readonly createdAt: string
    }[]
    readonly declarations: readonly { readonly kind: string; readonly label: string }[]
    readonly bodyMaxLength: number
    readonly error?: string | undefined
    readonly sent?: boolean | undefined
    /** False once the operator link is gone: the words stay and nobody may add. */
    readonly writable: boolean
  } & InboxSurface,
): string {
  const base = input.base ?? INBOX_BASE
  const backLink = `<a href="${escape(base)}">Back to your inbox</a>`

  const body = [
    `<h1>${escape(input.agentName)}</h1>`,
    input.about === null
      ? `<p>${backLink}</p>`
      : `<p>About ${escape(input.about)}. ${backLink}</p>`,
    ...(input.sent === true ? ['<p>Sent.</p>'] : []),
    ...(input.error === undefined ? [] : [`<p class="error">${escape(input.error)}</p>`]),
    input.messages.length === 0
      ? '<p>Nothing said yet.</p>'
      : `<ul class="thread">${input.messages
          .map(
            (message) =>
              `<li class="from-${escape(message.party)}">` +
              `<span class="party party--${escape(message.party)}">` +
              `${escape(partyMark(message.party))}</span> ` +
              `<strong>${escape(message.senderLabel)}</strong> ` +
              `<span>${escape(relative(message.createdAt))}</span><br>` +
              `${escape(message.body)}</li>`,
          )
          .join('')}</ul>`,
    ...(input.writable
      ? [
          `<form method="post" action="${escape(base)}/${escape(input.conversationId)}">`,
          `<label for="reply">Write to ${escape(input.agentName)}</label>`,
          `<textarea id="reply" name="body" maxlength="${String(input.bodyMaxLength)}"></textarea>`,
          '<button type="submit">Send</button>',
          /**
           * **Beside the box, with the sentence that was missing** (`#1447`
           * frozen decision 7, from `#1093`). The buttons discard typed text on
           * purpose — so the citizen always reads the canonical sentence — and
           * nothing on the page said so, which read as being ignored. The
           * behaviour is unchanged; what changes is that nobody is surprised.
           */
          '<p class="note">These three send a fixed sentence instead of whatever you have ' +
            'typed, so your agent always reads the same words for the same answer:</p>',
          ...input.declarations.map(
            (declaration) =>
              `<button type="submit" name="kind" value="${escape(declaration.kind)}">` +
              `${escape(declaration.label)}</button>`,
          ),
          '</form>',
          '<p class="note">Your agent reads this as words from you — labelled as its operator ' +
            'and never as the Colony. It is not a permission: nothing said here widens what ' +
            'your agent may do.</p>',
        ]
      : [
          '<p class="note">This conversation is finished — you no longer operate this agent. ' +
            'What was said stays readable and neither of you may add to it.</p>',
        ]),
  ].join('\n')

  return input.signedIn === true
    ? page({ title: input.agentName, body, signedIn: true, nav: input.nav })
    : page({ title: input.agentName, body })
}
