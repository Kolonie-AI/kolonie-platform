/**
 * Who is actually calling, when three hops sit in front of this process.
 *
 * The request path in production is **browser or agent → Cloudflare → Traefik →
 * this container**. Every one of those rewrites the socket address, so
 * `request.ip` here is Traefik on the shared Docker network — the same value for
 * every caller in the world. A rate limiter keyed on it limits everyone at once
 * and nobody in particular, which is the failure kolonie-platform#10 names
 * directly and the reason this module exists rather than a `request.ip` call at
 * the use site.
 */

/** Cloudflare's own header. It is the only one Cloudflare guarantees it sets. */
const CF_CONNECTING_IP = 'cf-connecting-ip'

/** The de-facto standard, appended to by each hop: `client, proxy1, proxy2`. */
const X_FORWARDED_FOR = 'x-forwarded-for'

/**
 * Resolve the caller's address from the headers the proxies added.
 *
 * Precedence, and the reasoning for the order:
 *
 * 1. **`CF-Connecting-IP`.** Cloudflare *overwrites* this on every proxied
 *    request, so a client that sends its own is discarded at the edge. That
 *    property is what makes it the first choice — `X-Forwarded-For` is appended
 *    to rather than replaced, so a client-supplied value survives as the
 *    leftmost entry.
 * 2. **`X-Forwarded-For`, leftmost.** Only reached when Cloudflare is not in the
 *    path — a local run, an integration test through Traefik alone, or a request
 *    that arrived at the origin some other way.
 * 3. **The socket address.** No proxy at all: a direct call, and the address is
 *    already the truth.
 *
 * ## What this does not claim
 *
 * **These headers are forgeable by anyone who can reach the origin directly.**
 * Nothing readable inside this process distinguishes "Cloudflare set this" from
 * "the caller typed it", so the value is trustworthy exactly to the degree that
 * the origin refuses connections that did not come through Cloudflare. That is
 * an infrastructure property, not an application one, and it is tracked as
 * kolonie-infra#21.
 *
 * The consequence is worth stating plainly rather than leaving implied: until
 * that holds, an attacker who has found the origin can rotate this header and
 * defeat the registration limit. It still stops the ordinary case — a script
 * pointed at the public hostname — and it stops it without punishing every other
 * caller, which is what keying on the proxy would do.
 */
export function clientIp(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  socketAddress: string,
): string {
  const cloudflare = firstValue(headers[CF_CONNECTING_IP])
  if (cloudflare !== undefined) return cloudflare

  const forwarded = firstValue(headers[X_FORWARDED_FOR])
  if (forwarded !== undefined) {
    // Leftmost: the chain reads client-first, and each hop appends. Taking the
    // last entry would key the limiter on the nearest proxy, which is the bug
    // this module exists to avoid.
    const [leftmost] = forwarded.split(',')
    const trimmed = leftmost?.trim()
    if (trimmed !== undefined && trimmed !== '') return trimmed
  }

  return socketAddress
}

/**
 * Node collapses a repeated header into an array. Take the first occurrence for
 * the same reason as the leftmost `X-Forwarded-For` entry: later ones were added
 * by something closer to us than the caller.
 */
function firstValue(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  const trimmed = raw?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
