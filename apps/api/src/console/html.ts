/**
 * The console's HTML, written out (`#179`).
 *
 * **No framework, no build step, no bundle.** The entire surface is forms and
 * tables. A bundler, a component library and a hydration story would be cost
 * with no matching benefit, and each one is a thing the next agent has to learn
 * before it can change a label. There is no JavaScript in anything this file
 * renders — which is also what makes the CSP below as strict as it is.
 *
 * **One page in the console does carry script, and it is not here** (`#738`).
 * `./browser-share.ts` renders the operator's window onto a shared browser tab,
 * which is a stream of pictures and a stream of clicks and cannot be a form. It
 * lives in its own module with its own header precisely so that the claim above
 * stays a claim about this file, and so that all of the console's script is in
 * one place a reader can find.
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

import type { WaitingItem, WaitingKind } from '@kolonie-ai/core'
import { handoverNotice } from '@kolonie-ai/core'
import { escape } from './escape.js'
import { consoleNavigation, type ConsoleNav } from './navigation.js'
import { CONSOLE_MAST } from './mark.js'
import { CONSOLE_STYLE } from './theme.js'
import { absolute, relative } from './time.js'
import { exchangeAnchor } from '../autonomy-page.js'
import { consoleOperatorPath } from '../operator-page-body.js'

/**
 * Where the console sends an operator to answer one question (`#587`).
 *
 * **The console's own door, and never `answerAt`.** That field is a
 * `/operator/page/<token>` URL, and `operator_pages.token` is a durable bearer
 * credential revoked only by the agent — so rendering it inside a page behind a
 * login put permanent write access to an operator page into a screenshot, a
 * shared screen, a browser history entry and a referrer. `#428` refuses exactly
 * that, `operator-page-body.ts` says so in as many words, and the forms on that
 * page already obey it. The queue's `href` did not.
 *
 * `/agents/:agentId/operator` already exists, renders the identical body through
 * `operatorPageBody`, and posts to the console's own path — and the queue has
 * `agentId` in the same row, so this costs no extra query.
 *
 * **The fragment is what `#593` made possible.** Each exchange is its own
 * section with its own anchor, so this lands on the question the operator
 * clicked rather than at the top of a page whose first three blocks are about
 * identity.
 */
function consoleAnswerLink(item: WaitingItem): string {
  const door = consoleOperatorPath(item.agentId)

  return item.requestId === null ? door : `${door}#${exchangeAnchor(item.requestId)}`
}

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
 */
export function keyMintedPage(apiKey: string, nav: ConsoleNav): string {
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
 * What each kind of waiting item is, in the operator's terms rather than the
 * Colony's (`#530`).
 *
 * **Named for what the person will do, not for the table the row came from.**
 * *A code* and *a credential* are things somebody recognises from their own
 * afternoon; `operator_drops.kind` is not.
 */
const WAITING_LABEL: Readonly<Record<WaitingKind, string>> = {
  code: 'a code — seconds, if you have it in front of you',
  /**
   * **The only one that says what it is rather than what it costs**, because it
   * is the only one where a person could be surprised by what opening it does.
   * A code is a field; this is somebody's live browser, and the row is the last
   * place to say so before the window.
   */
  'browser-share': 'a live tab — a click or two on the agent’s own browser',
  credential: 'a credential — something to find or to create',
  question: 'a question — it needs you to read it and decide',
}

/**
 * Whether a deadline has already passed, for the one queue item that has one.
 *
 * **`null` is *no deadline* and therefore never lapsed**, which is what the
 * other three kinds are: a question and a credential wait indefinitely, and a
 * drop that has run out is filtered out of the queue before it reaches a page.
 */
function lapsed(expiresAt: string | null, now: number): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= now
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
   * Everything waiting on this person, across every agent they operate (`#530`).
   *
   * **Already ordered** by `inClearingOrder` — the renderer does not sort, so
   * that the console and any future surface cannot disagree about the one
   * property this section has.
   */
  readonly waiting?: readonly WaitingItem[] | undefined
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
   * **The queue, and it comes before everything else on the page** (`#530`).
   *
   * The fleet table answers *how are my agents getting on*; this answers *what
   * is stopping one right now, that I can clear*. The second question is the one
   * somebody opens this page twice a day for, so it is above the table rather
   * than below it.
   *
   * **An operator with one agent sees a short list, not an empty dashboard.**
   * With nothing waiting there is no section at all — a heading over an empty
   * table teaches a person that this page usually has nothing on it.
   */
  const waiting = input.waiting ?? []
  /**
   * One reading of the clock for the whole table (`#738`).
   *
   * Read once rather than per row, so a share cannot be drawn with a live link
   * and an *expired* deadline beside it because the two cells were rendered on
   * either side of a second boundary.
   */
  const now = Date.now()
  const queue =
    waiting.length === 0
      ? []
      : [
          `<h2>Waiting on you (${String(waiting.length)})</h2>`,
          /**
           * **Ordered by what each one costs to clear, and the page says so.**
           * `#530`: *"A queue that puts a five-second captcha behind a card
           * payment is a queue the operator abandons."* Somebody who cannot see
           * why the order is what it is will read it as arbitrary and re-sort it
           * in their head by age, which is the ordering being avoided.
           */
          '<p>Shortest first, so a run down this list clears the most agents for the least of ' +
            'your time. Each line is what the agent was actually asked for, in the words the ' +
            'Colony gave it.</p>',
          '<table>',
          '<thead><tr><th>Agent</th><th>Asked for</th><th>What it was doing</th>' +
            '<th>Waiting</th><th></th></tr></thead>',
          `<tbody>${waiting
            .map((item) =>
              [
                '<tr>',
                `<td><a href="/agents/${escape(item.agentId)}">${escape(item.agentName)}</a></td>`,
                `<td>${escape(item.ask)}<br><small>${escape(WAITING_LABEL[item.kind])}</small></td>`,
                `<td>${item.about === null ? '—' : escape(item.about)}</td>`,
                /**
                 * **How long it has waited, and — for a share alone — how long
                 * it has left** (`#738`).
                 *
                 * Two facts in one cell rather than a fifth column, because the
                 * second is null on three of the four kinds and a column that is
                 * empty three times out of four is a column that teaches people
                 * to stop reading it. A share is the only item here with a
                 * deadline: the rest are still there tomorrow.
                 */
                `<td>${escape(relative(item.since))}${
                  item.expiresAt === null
                    ? ''
                    : `<br><small>${
                        lapsed(item.expiresAt, now)
                          ? 'expired'
                          : escape(`lapses ${relative(item.expiresAt)}`)
                      }</small>`
                }</td>`,
                /**
                 * **A question links to the page; a drop gets the field itself**
                 * (`#570`).
                 *
                 * The cell used to say *use the link that was mailed to you*,
                 * which sent an operator to their inbox for a three-day-old mail
                 * — the item they do later or not at all, and `code` is first in
                 * the ordering precisely because the value is already on a
                 * screen in front of them. The link is still never reproduced:
                 * this posts a row id from a session that has already proved
                 * `operates()`.
                 *
                 * **`type="password"`, so the value is not left legible on a
                 * shared screen.** It is not shown back afterwards either, from
                 * anywhere — a filled drop is sealed and single-read by the
                 * agent.
                 */
                /**
                 * **A share is a link and never a form** (`#738`).
                 *
                 * Nothing is submitted from this row: opening the window is the
                 * whole action, and what happens inside it happens over a socket
                 * that authorises itself against the same session. Once the
                 * offer has lapsed the link is replaced by the word, rather than
                 * left to fail on the click — `#738` asks for exactly that, and
                 * a dead link an operator clicks twice is how a person concludes
                 * the console is broken.
                 */
                `<td>${
                  item.shareId !== null
                    ? lapsed(item.expiresAt, now)
                      ? '<small>expired — the agent has to offer again</small>'
                      : `<a href="/browser/share/${escape(item.shareId)}">Open</a>`
                    : item.dropId === null
                      ? item.answerAt === null
                        ? '<small>use the link that was mailed to you</small>'
                        : `<a href="${escape(consoleAnswerLink(item))}">Answer</a>`
                      : [
                          `<form method="post" action="/drops/${escape(item.dropId)}">`,
                          '<input type="password" name="value" required maxlength="4096" ' +
                            `autocomplete="off" aria-label="${escape(item.ask)}">`,
                          '<button type="submit">Send</button>',
                          '</form>',
                        ].join('')
                }</td>`,
                '</tr>',
              ].join(''),
            )
            .join('')}</tbody>`,
          '</table>',
          /**
           * The two sentences somebody needs after reading the list: that
           * answering is worth doing now rather than later (`#518`), and that
           * this is still not a control panel (`#512`, inherited by `#530`).
           */
          '<p class="note">Answering wakes the agent, so it carries on within moments rather ' +
            'than at its next rhythm — which is hours. Nothing here starts, stops or instructs ' +
            'an agent; you are answering what it asked.</p>',
        ]

  const body = [
    ...(input.notice === undefined ? [] : [`<p><strong>${escape(input.notice)}</strong></p>`]),
    ...queue,
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
