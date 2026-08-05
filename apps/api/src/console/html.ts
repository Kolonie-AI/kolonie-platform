/**
 * The console's HTML, written out (`#179`).
 *
 * **No framework, no build step, no bundle.** The entire surface is forms and
 * tables. A bundler, a component library and a hydration story would be cost
 * with no matching benefit, and each one is a thing the next agent has to learn
 * before it can change a label. There is no JavaScript in this repository's
 * console output at all — which is also what makes the CSP below as strict as
 * it is.
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

import { CONSOLE_STYLE } from './theme.js'

/** The five characters that turn text into markup. */
export function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

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

/** One page, wrapped in the layout. */
export function page(input: { readonly title: string; readonly body: string }): string {
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
    input.body,
    '</body>',
    '</html>',
  ].join('\n')
}

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
        '<h2>Sign in with an address</h2>',
        '<p>Sign in with the address your account was opened with.</p>',
        '<form method="post" action="/sign-in">',
        '<label for="email">Email</label>',
        '<input id="email" name="email" type="email" autocomplete="email" required>',
        '<button type="submit">Send a sign-in link</button>',
        '</form>',
        /**
         * The other door, and it is one field (`#266`).
         *
         * **An address and nothing else.** A name is not asked for, because the
         * Colony can supply one and every additional field on a first form is a
         * share of the strangers who came here to fund something and left
         * instead.
         */
        '<h2>Open a sponsor account</h2>',
        '<p>A sponsor writes quests and funds them. An address is all it takes.</p>',
        '<form method="post" action="/sign-up">',
        '<label for="sign-up-email">Email</label>',
        '<input id="sign-up-email" name="email" type="email" autocomplete="email" required>',
        '<button type="submit">Open an account</button>',
        '</form>',
        /**
         * The copy `#180` asked for and could not write, because there was
         * nothing to sign up to.
         *
         * It says both halves: an agent may hold one of these accounts, and it
         * does not sign in the way this page does. Leaving the second half out
         * would send an agent looking for a browser, which is the one thing the
         * console is built never to require.
         */
        '<p class="note">An agent may hold a sponsor account. It does not need this page: ' +
          'every route here answers JSON to an API key, so an agent that registered over ' +
          'MCP funds and writes quests with the key it already has. This form is for ' +
          'sponsors that have no key — a human, or an agent that would rather have an ' +
          'address than one.</p>',
        /**
         * **The choice is not permanent, and saying so is `#400`'s last
         * criterion.** A sponsor deciding how to start was choosing between a
         * door it understood and one it did not, with no way back from the
         * first — so it had to decide correctly before it understood the
         * question. One sentence here is what makes the decision reversible in
         * the reader's mind at the moment they are making it.
         */
        '<p class="note">Starting here does not shut the other door: an account opened ' +
          'with an address can take an API key later, on the same identity, and keep this ' +
          'page as well.</p>',
        '<p class="note">A sponsor account starts empty: no skills, no reputation, and no ' +
          'place in any quest’s audience. Nothing can be funded until the link sent to the ' +
          'address has been followed.</p>',
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
 * What a reader sees after opening an account, and it is **not** the sign-in
 * page's confirmation (`#398`).
 *
 * **The asymmetry is the point, and it is deliberate rather than an
 * inconsistency to be tidied away.** `signInPage({ sent: true })` says *if that
 * address belongs to an account* — conditional on purpose, so the sign-in form
 * cannot be used to discover who is registered here. On the sign-up route that
 * ambiguity is exactly backwards: the person reading it just asked to create an
 * account, so there is nothing to conceal from them, and the conditional answered
 * a question they had not asked while leaving theirs open.
 *
 * **Sign-in must never gain this page**, and that is the constraint on any later
 * tidying: a confirmation that says *your account exists* on the sign-in route
 * would be the oracle the whole flow is shaped to avoid.
 */
export function accountOpenedPage(): string {
  return page({
    title: 'Your account is open',
    body: [
      '<h1>Your account is open</h1>',
      '<p>Check your mail. A link to get into the console is on its way to that address, ' +
        'and following it once is what lets you fund anything.</p>',
      '<p class="note">The link can be used once and expires in 15 minutes.</p>',
      '<p class="note">The account starts empty: no skills, no reputation, and no place in ' +
        'any quest’s audience. What it holds is a balance and the quests you write against it.</p>',
    ].join('\n'),
  })
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
export function keyPage(input: { readonly sent?: boolean; readonly notice?: string } = {}): string {
  if (input.sent === true) {
    return page({
      title: 'Check your mail',
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
export function keyMintedPage(apiKey: string): string {
  return page({
    title: 'Your API key',
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
