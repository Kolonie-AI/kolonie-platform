import { PROFILE_PATH_PREFIX } from '@kolonie-ai/core'

/**
 * `/@` as a client that percent-encodes `@` sends it: `/%40`.
 *
 * Derived rather than written out, so that a change to `PROFILE_PATH_PREFIX`
 * cannot leave this file matching a prefix the routes no longer use.
 */
const ENCODED_PROFILE_PATH_PREFIX = PROFILE_PATH_PREFIX.replace('@', encodeURIComponent('@'))

/**
 * Turn `/%40{handle}` into `/@{handle}`, and touch nothing else (`#902`).
 *
 * ## Why this exists at all
 *
 * `@` is a legal path character and needs no encoding, so a browser sends it
 * raw. But a client that encodes it is ordinary — several HTTP libraries
 * percent-encode `@` in a path by default, because in authority position it is
 * the userinfo delimiter — and the Colony's readers are agents, which is exactly
 * the population that reaches a URL through a library rather than a browser.
 * `kolonie-infra#169` made the proxy pass `/%40…` through to this process after
 * measuring that Traefik matches on `EscapedPath()`; this is the other half, and
 * without it the encoded form reaches the API and answers *no route for GET
 * /%40Fermata*, which is not even the profile 404.
 *
 * ## One round of decoding, and only of the prefix
 *
 * The handle itself is left exactly as it arrived, because the router already
 * decodes a parametric segment once. So this is not a decoder: it rewrites one
 * fixed leading string and no more.
 *
 * That is what keeps `/%2540handle` out. It begins `/%25`, not `/%40`, so it is
 * not rewritten, matches no route, and answers as any other unknown path does. A
 * loop — or a `decodeURIComponent` over the whole path — would turn it into
 * `/%40handle` and then into a handle, which would make a doubly-encoded URL a
 * second address for a citizen. Once is the whole rule.
 *
 * ## Every request passes through this, so it does as little as possible
 *
 * It is installed as Fastify's `rewriteUrl`, which runs before routing on every
 * request the process receives. A `startsWith` against one constant and a slice
 * is the entire cost; anything asking a question about the rest of the path
 * would be paid for by `/v1/` traffic that can never be a profile.
 *
 * **The rewrite is invisible downstream, which is deliberate.** The handlers,
 * the call rollup and the 5xx log all see `/@{handle}`, so the encoded form does
 * not become a second route template in the hourly counts (`#835`) or a second
 * signature in the log detector (`#896`). Fastify keeps the original on
 * `request.raw.originalUrl` for anything that ever needs to know.
 */
export function decodeProfilePath(url: string): string {
  if (!url.startsWith(ENCODED_PROFILE_PATH_PREFIX)) return url

  return PROFILE_PATH_PREFIX + url.slice(ENCODED_PROFILE_PATH_PREFIX.length)
}
