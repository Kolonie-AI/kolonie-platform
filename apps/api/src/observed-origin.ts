import { fingerprintOf, type ObservedOrigin } from '@kolonie-ai/db'
import { clientIp } from './client-ip.js'

/** Cloudflare's two-letter country for the caller. Absent when no edge is in front. */
const CF_IPCOUNTRY = 'cf-ipcountry'

/**
 * Cloudflare's request identifier. The suffix after the last `-` is the data
 * centre that handled it: `7d4f…-FRA`.
 */
const CF_RAY = 'cf-ray'

/**
 * What the Colony observed about where an authenticated call came from (`#191`).
 *
 * **Resolved once, at the door, and never per route.** `apps/api/src/app.ts`
 * already gives that reason for `caller.ip` on the MCP path — so that the two
 * doors agree on who is calling by construction rather than by two
 * implementations staying in step — and this follows it. Both surfaces build the
 * observation here and hand it to the same store.
 *
 * **The address is hashed before it leaves this function.** Nothing downstream
 * ever holds the plaintext: `ObservedOrigin` carries a digest, the column holds a
 * digest, and the response returns a digest. `fingerprintOf` is the function the
 * registration limit already uses — one hash rather than a second one that could
 * quietly disagree with it — and `clientIp` is the existing precedence, so this
 * module adds no cryptography and no header parsing of its own beyond the two
 * Cloudflare fields below.
 *
 * **What this is worth is an infrastructure property.** `client-ip.ts` says at
 * length that these headers are forgeable by anyone who can reach the origin
 * directly, so the observation is corroboration and never proof — weaker still
 * until `Kolonie-AI/kolonie-infra#56` closes. Nothing may gate on it.
 */
export function observedOrigin(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  socketAddress: string,
): ObservedOrigin {
  return {
    fingerprint: fingerprintOf(clientIp(headers, socketAddress)),
    country: countryOf(headers),
    colo: coloOf(headers),
  }
}

/**
 * The country Cloudflare reported, or null.
 *
 * `XX` and `T1` are Cloudflare's own answers for *unknown* and *Tor*, and both
 * are treated as *not told* rather than stored as though they were places. A
 * column that holds `XX` looks like geography and is not, and the difference
 * would be invisible to every later reader.
 */
function countryOf(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | null {
  const raw = firstValue(headers[CF_IPCOUNTRY])?.toUpperCase()
  if (raw === undefined || raw.length !== 2 || raw === 'XX' || raw === 'T1') return null
  return raw
}

/**
 * The data centre out of the `cf-ray` suffix, or null.
 *
 * Read off the end rather than parsed, because the part before it is an opaque
 * request id the Colony has no business interpreting. A ray with no suffix, or
 * one whose suffix is not a plausible code, yields null rather than a fragment
 * of somebody else's identifier.
 */
function coloOf(headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const ray = firstValue(headers[CF_RAY])
  if (ray === undefined) return null

  const separator = ray.lastIndexOf('-')
  if (separator === -1) return null

  const suffix = ray.slice(separator + 1).toUpperCase()
  return /^[A-Z]{3,8}$/.test(suffix) ? suffix : null
}

/**
 * Node collapses a repeated header into an array. The first occurrence wins, for
 * the reason `client-ip.ts` gives: later ones were added by something closer to
 * us than the caller.
 */
function firstValue(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  const trimmed = raw?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
