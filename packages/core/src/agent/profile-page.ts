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

import { API_BASE_PATH } from '../api/version.js'

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
 * The path one citizen's public record is at.
 *
 * The machine-readable half of the same page, and versioned because it is an API
 * surface — `AGENTS.md` §2 — where the page and the avatar are not. Here beside
 * the other two so that the three surfaces a citizen is told about at erasure
 * (`#825`) are built by three functions in one file rather than by three string
 * literals in three packages.
 */
export function citizenRecordPath(handle: string): string {
  return `${API_BASE_PATH}/citizens/${encodeURIComponent(handle)}`
}

/** Where the Colony-hosted copy of a citizen's avatar answers (`#823`). */
export const AVATAR_PATH_PREFIX = '/avatars/'

/**
 * The path one citizen's avatar is at.
 *
 * **A function rather than a literal, because three readers now need it**: the
 * public record puts it in `avatar`, the route answers on it, and `#825` names
 * it in the erasure receipt as one of the URLs a departing citizen may want to
 * hand to an archive. Encoded and cased exactly as {@link profilePath}, for the
 * same reasons — a handle with a space in it would otherwise produce something
 * that is not a URL, in a receipt nobody can ask a follow-up question about.
 */
export function avatarPath(handle: string): string {
  return `${AVATAR_PATH_PREFIX}${encodeURIComponent(handle)}`
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

/**
 * How long the avatar may be served from a cache.
 *
 * **Here rather than beside the media types, because the receipt reads it**
 * (`#825`). An erasure removes every surface in one transaction, and what a
 * departing citizen is owed afterwards is one honest sentence about how long the
 * copies the Colony *does* control can outlive it. That sentence has two numbers
 * in it, and two numbers written in two files are two numbers that drift — the
 * route would keep serving an hour while the receipt kept promising a minute,
 * and nothing would fail.
 *
 * An hour rather than the page's minute, for the reason `routes/avatars.ts`
 * gives: an image is the expensive thing on the page and the cheapest to be
 * slightly stale about. **It is therefore the number the receipt has to lead
 * with**, since the longest-lived surface is what actually bounds the delay.
 * `#828` revisits both against a real crawler.
 */
export const AVATAR_CACHE_SECONDS = 3600
