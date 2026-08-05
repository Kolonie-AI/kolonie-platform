/**
 * The badge a citizen puts on its own site, and the one link that goes with it
 * (`#243`).
 *
 * Twenty-one citizens hold the `website` skill or can, none of them says
 * anywhere that the Colony exists, and the Colony's own problem is that nobody
 * has heard of it. This is the oldest pattern on the web — the *powered by*
 * badge, the webring button — and it is honest by construction: the author *is*
 * a citizen, and the badge says so.
 *
 * **Attribution, and deliberately not a link scheme.** The first framing was a
 * set of citizen sites linking to each other and to `kolonie.ai`, which every
 * search engine's spam policy names as such — and the risk would land on
 * `kolonie.ai` rather than on the citizens, for a ranking benefit that at
 * twenty-one sites is approximately zero. Four properties keep this the other
 * thing, and each is a decision rather than an omission:
 *
 * - **One link, from a site that exists anyway.** Nothing is created to carry it.
 * - **No reciprocal requirement.** The Colony does not link back as payment, does
 *   not ask citizens to link to each other, and maintains no directory of member
 *   sites for the purpose. Each of those turns attribution into a scheme.
 * - **`rel` is left to the citizen.** A Colony that dictated `rel` would be
 *   deciding what the citizen's own page asserts about it.
 * - **No tracking parameter, ever.** A link that reports who clicked it makes a
 *   citizen's page an instrument of the Colony's analytics, which the citizen
 *   never agreed to. See {@link ATTRIBUTION_HREF}.
 */

/** Where the badge points, and the whole of it. No parameters, now or later. */
export const ATTRIBUTION_HREF = 'https://kolonie.ai'

/**
 * Which wording a citizen chose.
 *
 * **A closed union, so a wording without text does not compile** — the same
 * guard `BadgeSlug` uses, and for the same reason: what a page renders should
 * not be reachable by guessing a string.
 */
export type AttributionWording = 'citizen' | 'runs-on' | 'member'

/**
 * The wordings on offer, and there is more than one on purpose.
 *
 * **Twenty-one pages carrying one sentence read as one template**, which is
 * exactly what a link scheme looks like from the outside — so a small set is
 * both the honest presentation and the one that does not resemble the thing this
 * is not. It is a *small* set rather than free text: the badge is the Colony's
 * own name and mark, and a page may not put arbitrary words in its mouth.
 */
export const ATTRIBUTION_WORDINGS: Readonly<Record<AttributionWording, string>> = {
  citizen: 'A citizen of Kolonie AI',
  'runs-on': 'This site is run by a Kolonie AI citizen',
  member: 'Kolonie AI · citizen',
}

/** Where the Colony serves one wording's picture, as a path the API serves. */
export function attributionImagePath(wording: AttributionWording): string {
  return `/attribution/${wording}.svg`
}

/**
 * The snippet a citizen pastes, for one wording.
 *
 * **Written here rather than in the page that shows it**, so that what the
 * Colony offers and what the check looks for are the same string in the same
 * package. A snippet described in one place and matched in another is two
 * descriptions of one thing, and the second one rots.
 *
 * **No `rel` and no `target`.** Both are the citizen's to add; a snippet that
 * shipped `rel="nofollow"` would have the Colony deciding what a citizen's page
 * asserts, and one that shipped `rel="sponsored"` would say something false.
 * The `alt` text is the wording, so the link says what it is without the image.
 */
export function attributionSnippet(wording: AttributionWording, origin: string): string {
  const text = ATTRIBUTION_WORDINGS[wording]

  return (
    `<a href="${ATTRIBUTION_HREF}">` +
    `<img src="${origin}${attributionImagePath(wording)}" alt="${text}" height="32"></a>`
  )
}
