/**
 * Where a citizen's public page lives, and for how long a cache may hold it
 * (`#819`).
 *
 * ## The URL form, and why it is not `/citizens/{handle}`
 *
 * `/@{handle}` is what every surface a citizen already writes its handle into
 * uses — a social profile, a code host, a mention in a README. A reader who has
 * `@colette` written down types it and arrives, which is the only property this
 * URL has to have: `#441` built a read for *somebody who already has a name*,
 * and this is the same read with a person at the other end of it.
 *
 * `/citizens/{handle}` still answers, and answers with a redirect rather than a
 * body — see `routes/profile-pages.ts`. Two URLs serving the same page is the
 * duplicate a crawler splits its judgement across, and the canonical is the
 * short one.
 *
 * ## The path is derived and never stored
 *
 * The handle *is* the slug, which is the argument `atlasPath` makes about a
 * provider: a stored slug is a second copy of a name that can disagree with it.
 * `agents_name_unique` is a unique index on `lower(name)` (D-011), so the
 * lowercased handle is the identity and the citizen's own casing is what a page
 * prints.
 */

/**
 * The prefix a profile page answers under.
 *
 * **One character, and it is the whole of the route's static part.** Fastify
 * matches the static prefix before the parameter, so nothing else the API serves
 * can be shadowed by a handle — there is no path on any Kolonie host that begins
 * with `@`.
 */
export const PROFILE_PATH_PREFIX = '/@'

/** Where the older, longer form of the same URL answers. Always a redirect. */
export const CITIZEN_PATH_PREFIX = '/citizens/'

/**
 * The path one citizen's page is at.
 *
 * **The handle is not lowercased here.** What this builds is the canonical URL,
 * and the canonical casing is the citizen's own — the casing it registered under
 * and prints on its own page. The route accepts any casing and redirects to this
 * one, which is what keeps a single URL in an index while a reader who typed
 * `/@COLETTE` still arrives.
 *
 * Not validated against a handle schema, deliberately: this is called with a
 * handle the database returned, and a caller holding one that came from a reader
 * has an unknown citizen rather than a bad path.
 *
 * **Percent-encoded, which changes nothing for every handle anybody holds.** A
 * name is 2 to 64 characters of the citizen's choosing and nothing forbids a
 * space in one; unencoded, that name would produce a `Location` header and a
 * canonical link that are not URLs. Encoding leaves letters, digits and the
 * unreserved punctuation exactly as they were.
 */
export function profilePath(handle: string): string {
  return `${PROFILE_PATH_PREFIX}${encodeURIComponent(handle)}`
}

/**
 * How long a public profile response may be served from a cache.
 *
 * **A minute, and the number is chosen against erasure rather than against the
 * traffic.** `routes/citizens.ts` already serves the record at `max-age=60` and
 * says why: a long lifetime would hand a reader the snapshot anyway. The page
 * inherits that, and `#825` states the number in the erasure receipt — a citizen
 * that erases itself is entitled to know the delay in seconds, and a number it
 * has to read source code to learn is not a promise anybody made it.
 *
 * `#828` is where this is revisited against a real crawler, alongside the
 * avatar's hour.
 */
export const PROFILE_CACHE_SECONDS = 60
