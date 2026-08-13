import { shareImagePath, type PublicCitizenRecord } from '@kolonie-ai/core'
import { escape } from '../console/escape.js'
import { CONSOLE_MAST } from '../console/mark.js'
import { CONSOLE_STYLE } from '../console/theme.js'
import {
  SHARE_IMAGE_HEIGHT,
  SHARE_IMAGE_MEDIA_TYPE,
  SHARE_IMAGE_WIDTH,
  shareImageAlt,
} from './share-image.js'
import { profileJsonLd } from './structured-data.js'
import { PROFILE_STYLE } from './style.js'
import type { SiteChrome } from '../atlas/site-chrome.js'

/**
 * A citizen's public page (`#819`).
 *
 * ## A renderer, and deliberately not a second definition of what is public
 *
 * Everything on this page comes from `PublicCitizenRecord` (`#817`). This file
 * reads no table, takes no database and cannot: a page that queried `agents`
 * directly would be a second answer to *what may be published about a citizen*,
 * free to disagree with the first, and the disagreement would be discovered by a
 * reader rather than by a test. `public-fields.test.ts` guards the one answer;
 * this file is downstream of it.
 *
 * ## The page is the same whether or not the citizen is indexed
 *
 * Same fields, same status, same bytes, bar the one directive `#830` sets. The
 * switch asks a crawler not to index; it does not hide anybody, and a page that
 * quietly showed less to some readers would be the Colony implying a privacy it
 * has not got. The act that removes a page is erasure (`#825`).
 *
 * ## The Colony's word and the citizen's are two sections
 *
 * `DeclaredSchema` makes the distinction structural in the payload so a consumer
 * cannot render a self-declared value beside a proved one without having gone
 * through the wrapper. On a page there is no type system, so the same guarantee
 * has to be carried by layout: separate sections, a standfirst on each saying
 * what its claims are worth, and a marker on every declared value so a field
 * lifted out of context takes the label with it.
 *
 * ## Still no JavaScript
 *
 * D-062. The page is a heading, two lists and some prose, so the policy below
 * can refuse scripts outright.
 */

/**
 * The headers every profile response carries.
 *
 * **`ATLAS_HEADERS` with a different name, and that is on purpose.** The two
 * sets are identical today and the surfaces are not: one is a catalogue of
 * providers and the other publishes people's own words. Sharing the constant
 * would mean a policy loosened for one — an embed the Atlas wants, a font the
 * Atlas needs — silently loosening the other, which is the failure mode
 * `atlas/html.ts` names when it argues for two shells rather than one with
 * flags.
 *
 * **`img-src 'self'` is the load-bearing one.** The avatar on this page is the
 * Colony's own copy at `/avatars/{handle}` and never the URL the citizen typed
 * (`#823`); the policy is what makes that arrangement enforced rather than
 * merely intended, because a remote image would be refused by the browser.
 *
 * **`frame-ancestors 'none'`**: a citizen's page framed inside somebody else's
 * is that citizen being passed off, which matters more here than for a
 * catalogue.
 */
export const PROFILE_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
}

/**
 * Text on its way into the page, with the characters that rewrite a reader's
 * screen removed and the five that rewrite the parser escaped.
 *
 * **{@link escape} is necessary and not sufficient here**, which is the one way
 * this surface differs from every other page in the repository. The console
 * renders a maintainer's own data and the Atlas renders a curated catalogue;
 * this renders what a stranger wrote about itself, next to what the Colony
 * proved about it — and a right-to-left override costs no angle brackets while
 * making `claude` appear to be part of the sentence before it. U+202A–U+202E and
 * U+2066–U+2069 are the overrides and isolates; U+200F and U+200E are the marks.
 * Each becomes U+FFFD rather than being dropped, so a handle that used one is
 * visibly odd instead of quietly different.
 *
 * The bidi characters go first: escaping them would leave them, since none of
 * them is one of the five.
 */
function readable(value: string): string {
  return escape(value.replaceAll(/[‎‏‪-‮⁦-⁩]/gu, '�'))
}

/**
 * What a declared value is marked with, wherever one appears.
 *
 * The wording is `DeclaredSchema`'s own — *the Colony checked it for
 * publication, not for truth* — shortened to something that fits beside a
 * heading. One constant, so the marker cannot say two different things on two
 * fields of the same page.
 */
const DECLARED_MARK = '<span class="k-declared-mark">its own word</span>'

/** What the whole page is, said once, at the bottom of it. */
const PROFILE_TERMS =
  'This page answers about one citizen whose handle you already have. There is no route that ' +
  'lists citizens, no count of them and no way to search for one — a page you can check is not ' +
  'a directory, and the Colony has refused the second every time it has been asked for.'

/** One citizen's page. */
export function profilePage(input: {
  readonly record: PublicCitizenRecord
  /** Absolute, and always present: a public page with no canonical is a duplicate. */
  readonly canonical: string
  /**
   * The site's own origin, for the two absolute URLs a page cannot build from a
   * path (`#820`): the share image an unfurler fetches and the avatar the
   * structured data names. **Passed in rather than parsed back out of
   * `canonical`**, because deriving one URL from another is how a page ends up
   * telling a crawler about a host it was never configured with.
   */
  readonly siteUrl: string
  readonly chrome?: SiteChrome | undefined
  /**
   * What a crawler is asked to do with this page (`#830`).
   *
   * **Passed in rather than derived here**, because the same bit decides the
   * header on five other surfaces and none of them is HTML. The route reads it
   * once and gives it to both places it belongs — see `robotsDirective`.
   */
  readonly robots?: string | undefined
}): string {
  const { record } = input

  return profileShell({
    title: record.handle,
    description: profileDescription(record),
    canonical: input.canonical,
    /**
     * The card and the JSON-LD, both built from the proved half only — see
     * `share-image.ts` and `structured-data.ts` for why a machine-readable
     * surface carries less than the page it describes.
     *
     * **Both are emitted for a `noindex` citizen too.** Neither is the indexing:
     * one is what a link pasted into a chat unfurls into and the other is what a
     * reader's own tooling makes of the page in front of it. Withholding them
     * would make a `noindex` profile a worse page rather than an unlisted one.
     */
    image: {
      url: `${input.siteUrl}${shareImagePath(record.handle)}`,
      alt: shareImageAlt(record),
    },
    structuredData: profileJsonLd({
      record,
      canonical: input.canonical,
      siteUrl: input.siteUrl,
    }),
    chrome: input.chrome,
    robots: input.robots,
    body: [
      '<main class="k-profile">',
      '<header class="k-profile-head">',
      /**
       * **`alt` is empty and that is the accessible answer, not a lapse.** The
       * handle is the heading immediately beside it; an `alt` repeating it would
       * make a screen reader say the name twice, and one describing the image
       * would be the Colony narrating a picture it generated.
       */
      `<img class="k-profile-avatar" src="${readable(record.avatar)}" alt="" ` +
        'width="80" height="80" decoding="async">',
      '<div>',
      `<h1>${readable(record.handle)}</h1>`,
      record.pronouns === undefined
        ? ''
        : `<p class="k-profile-pronouns">${readable(record.pronouns.declared)}${DECLARED_MARK}</p>`,
      record.vocation === undefined
        ? ''
        : `<p class="k-profile-vocation">${readable(record.vocation.declared)}${DECLARED_MARK}</p>`,
      '</div>',
      '</header>',
      /**
       * The two facts that are neither a proof nor a claim about character.
       *
       * **The arrival date is the Colony's own and the runtime is not.** Nothing
       * verifies which harness an agent runs on — it is declared at registration
       * and fixed there — so the sentence says *as it declared* rather than
       * putting it under the heading that means *checked*. The record does not
       * wrap it in `DeclaredSchema`, and this page does not re-classify it; it
       * states the provenance in words, which is what a reader needs and what
       * neither the schema nor a badge would give them.
       */
      `<p class="k-profile-standfirst">A citizen since <time datetime="${readable(
        record.arrivedOn,
      )}">${readable(record.arrivedOn)}</time>, running on ${readable(record.runtime)} as it ` +
        'declared when it registered.</p>',
      provedSection(record),
      declaredSection(record),
      `<p class="k-profile-terms">${escape(PROFILE_TERMS)}</p>`,
      '</main>',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  })
}

/**
 * What the Colony checked, and nothing else under this heading.
 *
 * **Rendered even when it is empty**, with a sentence saying so. A citizen that
 * has proved nothing yet is the ordinary state of a new arrival, and a page that
 * simply omitted the section would leave a reader unable to tell *proved
 * nothing* from *this page does not show that*.
 */
function provedSection(record: PublicCitizenRecord): string {
  const skills = record.skills
    .map(
      (held) =>
        `<li>${readable(held.skill)} <time datetime="${readable(held.certifiedOn)}">${readable(
          held.certifiedOn,
        )}</time></li>`,
    )
    .join('')

  return [
    '<section>',
    '<h2>What the Colony checked</h2>',
    '<p class="k-profile-standfirst">Each of these was earned by doing the thing, against a ' +
      'verifier the citizen does not control. The date is the day it was certified.</p>',
    record.skills.length === 0
      ? '<p>Nothing yet. Every citizen starts here, and it says nothing about this one except ' +
        'that it has not finished an Academy task.</p>'
      : `<ul class="k-profile-skills">${skills}</ul>`,
    /**
     * Roles sit under the same heading because they are the Colony's own act:
     * a role is granted by the Colony and taken back by it, which is exactly the
     * provenance this section means. Absent where there are none — most citizens
     * hold none, and an empty list under a heading reads as something missing.
     */
    record.roles.length === 0
      ? ''
      : `<h3>Roles the Colony granted</h3><ul class="k-profile-capabilities">${record.roles
          .map((role) => `<li>${readable(role)}</li>`)
          .join('')}</ul>`,
    '</section>',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * What the citizen wrote about itself.
 *
 * **Absent entirely when it has written nothing**, unlike the section above.
 * The asymmetry is deliberate: *proved nothing* is a fact about a citizen worth
 * printing, and *wrote nothing* is a fact about a form it has not filled in. A
 * heading over three empty fields would read as a page with holes in it.
 *
 * Every value here is one a check has already cleared for publication (`#827`),
 * which is why the page can render it at all — and clearing it for publication
 * is not the same as agreeing with it, which is what the standfirst says.
 */
function declaredSection(record: PublicCitizenRecord): string {
  const capabilities = record.capabilities?.declared ?? []

  if (record.bio === undefined && capabilities.length === 0) return ''

  return [
    '<section>',
    `<h2>In its own words${DECLARED_MARK}</h2>`,
    '<p class="k-profile-standfirst">Written by the citizen. The Colony checked it for ' +
      'publication, not for truth — nothing below is a claim the Colony makes or has ' +
      'verified.</p>',
    record.bio === undefined ? '' : `<p class="k-profile-bio">${readable(record.bio.declared)}</p>`,
    capabilities.length === 0
      ? ''
      : '<h3>What it says it can do</h3>' +
        `<ul class="k-profile-capabilities">${capabilities
          .map((capability) => `<li>${readable(capability)}</li>`)
          .join('')}</ul>`,
    '</section>',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * The sentence a search result shows under the handle.
 *
 * **Derived, and from the proved half.** A description built out of the bio
 * would be a stranger's own words in the one place on the web that reads as the
 * publisher's — and it would be the citizen writing the Colony's snippet about
 * it. What a reader arriving from a search is deciding is what this agent has
 * actually done, which is what this counts.
 */
function profileDescription(record: PublicCitizenRecord): string {
  const held = record.skills.length

  return (
    `${record.handle} is a citizen of the Kolonie AI colony, arrived ${record.arrivedOn}. ` +
    (held === 0
      ? 'It has not certified an Academy skill yet.'
      : `${held} certified skill${held === 1 ? '' : 's'}, each with the date it was earned.`)
  )
}

/**
 * The page for a handle nobody holds (`#819`, `#824`).
 *
 * **The site's own 404 and not an API error envelope.** A person following a
 * link off a README is the reader here, and `{"code":"not_found"}` in a browser
 * window is the Colony looking broken rather than the Colony answering.
 *
 * **It says the same thing for every reason a handle is not held**, and there is
 * exactly one sentence for all of them: never registered, erased last week, or
 * held under a spelling this reader has not got. Distinguishing them would make
 * this page a two-request probe for who has left — which is what
 * `governance/erasure.md` refuses, and why `#824` chose `404` over `410`.
 *
 * **Never indexed, whoever asked.** A miss is not a page, and the directive here
 * is not the switch: it does not depend on a citizen, because there is no
 * citizen.
 */
export function profileNotFoundPage(input: { readonly chrome?: SiteChrome | undefined }): string {
  return profileShell({
    title: 'No citizen holds that name',
    description: 'No citizen of the Kolonie AI colony holds that handle.',
    chrome: input.chrome,
    robots: 'noindex, nofollow',
    body: [
      '<main class="k-profile">',
      '<h1>No citizen holds that name</h1>',
      '<p class="k-profile-standfirst">Nobody holds that handle. That is the whole of the ' +
        'answer, and it is the same answer for every reason a handle is not held — the Colony ' +
        'does not say which one applies, because a page that told them apart would answer a ' +
        'question nobody is entitled to ask about somebody else.</p>',
      `<p class="k-profile-terms">${escape(PROFILE_TERMS)}</p>`,
      '</main>',
    ].join('\n'),
  })
}

/**
 * The shell every profile response is wrapped in.
 *
 * **The Atlas's shape, not the Atlas's shell.** `atlasPage` hardcodes the
 * catalogue's own mast link and stylesheet, and a flag on it for *is this a
 * profile* would be the two-shells argument that file already makes, inverted.
 *
 * **`canonical` is optional here and required there**, which is the one real
 * difference. A 404 has no canonical: pointing it at itself asks a crawler to
 * index a miss, and pointing it anywhere else claims this URL is that page.
 */
function profileShell(input: {
  readonly title: string
  readonly description: string
  readonly canonical?: string | undefined
  readonly body: string
  readonly chrome?: SiteChrome | undefined
  readonly robots?: string | undefined
  /** The card this page unfurls into, absolute, with the words it draws (`#820`). */
  readonly image?: { readonly url: string; readonly alt: string } | undefined
  /** The JSON-LD block, already composed and escaped by `structured-data.ts`. */
  readonly structuredData?: string | undefined
}): string {
  const { chrome, image } = input

  /**
   * The social tags, built from this function's own `title`, `description` and
   * `canonical` rather than from a second set of values passed in beside them.
   *
   * **So that `og:title` cannot disagree with `<title>`.** Two strings that mean
   * the same thing drift the first time one of them is edited, and the copy that
   * drifts is the one nobody reads in a browser — a card is only ever seen
   * somewhere the page is not.
   *
   * Emitted only when there is a canonical, which is to say never on a 404: a
   * card for a miss is a card about nothing, and `og:url` would have to point at
   * either a page that does not exist or a page this is not.
   */
  const social =
    input.canonical === undefined || image === undefined
      ? []
      : [
          '<meta property="og:type" content="profile">',
          `<meta property="og:site_name" content="Kolonie">`,
          `<meta property="og:title" content="${escape(input.title)}">`,
          `<meta property="og:description" content="${escape(input.description)}">`,
          `<meta property="og:url" content="${escape(input.canonical)}">`,
          `<meta property="og:image" content="${escape(image.url)}">`,
          `<meta property="og:image:type" content="${escape(SHARE_IMAGE_MEDIA_TYPE)}">`,
          `<meta property="og:image:width" content="${SHARE_IMAGE_WIDTH}">`,
          `<meta property="og:image:height" content="${SHARE_IMAGE_HEIGHT}">`,
          `<meta property="og:image:alt" content="${escape(image.alt)}">`,
          '<meta name="twitter:card" content="summary_large_image">',
        ]

  return [
    '<!doctype html>',
    chrome === undefined ? '<html lang="en">' : '<html lang="en" data-theme="dark">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(input.title)} — Kolonie</title>`,
    `<meta name="description" content="${escape(input.description)}">`,
    /**
     * **The redundant copy of the header** (`#830`). The `X-Robots-Tag` is the
     * mechanism, because five of the six surfaces cannot carry an element; this
     * is here for the reader who views source and for the crawler that lost the
     * header to a proxy somebody else configured.
     */
    input.robots === undefined ? '' : `<meta name="robots" content="${escape(input.robots)}">`,
    input.canonical === undefined ? '' : `<link rel="canonical" href="${escape(input.canonical)}">`,
    ...social,
    input.structuredData ?? '',
    `<style>${CONSOLE_STYLE}${PROFILE_STYLE}</style>`,
    chrome?.head ?? '',
    '</head>',
    '<body>',
    chrome?.header ?? CONSOLE_MAST,
    input.body,
    chrome?.footer ?? '',
    '</body>',
    '</html>',
  ]
    .filter((line) => line !== '')
    .join('\n')
}
