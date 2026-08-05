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
 */

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

/**
 * The whole stylesheet, inline, because there is no second file to serve.
 *
 * A static asset route would be one more thing to cache, to version and to get
 * wrong; the console's CSS is shorter than the code that would serve it.
 */
const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 ui-monospace, monospace; margin: 0 auto; max-width: 46rem; padding: 2rem 1rem; }
  h1 { font-size: 1.3rem; }
  a { color: inherit; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid currentColor; padding: 0.4rem 0.5rem; text-align: left; }
  input { font: inherit; padding: 0.4rem; width: 100%; box-sizing: border-box; }
  button { font: inherit; padding: 0.4rem 1rem; margin-top: 0.6rem; }
  .note { opacity: 0.75; }
`

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
    `<style>${STYLE}</style>`,
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
  input: { readonly sent?: boolean; readonly notice?: string } = {},
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
        '<p class="note">A sponsor account starts empty: no skills, no reputation, and no ' +
          'place in any quest’s audience. Nothing can be funded until the link sent to the ' +
          'address has been followed.</p>',
      ]

  return page({ title: 'Sign in', body: body.join('\n') })
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
