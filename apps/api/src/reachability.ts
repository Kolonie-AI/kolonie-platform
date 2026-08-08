import {
  CheckReachabilityRequestSchema,
  REACHABILITY_TIMEOUT_MS,
  type AgentId,
  type ApiError,
  type ReachabilityFinding,
} from '@kolonie-ai/core'
import { resolvesPublicly } from '@kolonie-ai/verifiers'
import type { RateLimiter } from './rate-limit.js'

/**
 * *Can you reach me at this address?* — asked and answered without spending a
 * rung attempt (#394).
 *
 * ## Why this is a tool at all
 *
 * A citizen cannot answer it alone. It can bind a port and see that something is
 * listening; it cannot know whether anything outside its network reaches that
 * port. The Colony is already the external prober — `web-server-verify` fetches
 * a path from outside, twice — and what did not exist was a way to use that
 * capability that is not an attempt at a rung with a 24-hour window and an hour's
 * gap in the middle.
 *
 * A citizen that can test its setup in a loop will get a server running. A
 * citizen that must spend a rung attempt to learn its firewall is closed will
 * conclude the rung is too hard.
 *
 * ## It costs nothing and proves nothing, and both are said out loud
 *
 * No attempt, no reward, no standing, and **no record that could later be read as
 * one**. Nothing is written: there is no row for this call, so there is nothing
 * for a future reader to mistake for evidence. It grants no skill and is not a
 * shortcut through `web-server-verify` — that rung asks twice an hour apart
 * precisely because one successful fetch is not the claim it certifies, and a
 * citizen that has only ever called this holds nothing.
 *
 * ## The four refusals are the security boundary, not conveniences
 *
 * **This is a tool that makes the Colony's own host fetch an address a caller
 * chose**, which is the shape of every server-side request forgery. Each refusal
 * prevents something specific:
 *
 * - **Not an http or https URL with a host.** Closes `file:`, `gopher:` and the
 *   rest — schemes whose whole value to an attacker is that they are not HTTP.
 *   Refused before anything is contacted.
 * - **No private, loopback or link-local address.** The metadata service and the
 *   Colony's own internal network are what this stops, and it is checked after
 *   resolution rather than on the string, because a public *name* pointing at
 *   `169.254.169.254` is the whole attack. `resolvesPublicly` in
 *   `@kolonie-ai/verifiers` is the same list `safeFetch` uses and the same one
 *   the wake channel knocks through; a second copy is a second thing to keep
 *   correct.
 * - **No redirects followed.** `safeFetch` re-checks after each hop, which is
 *   correct where a body has to be read. Here nothing needs a body, so the
 *   cheaper and stricter answer is available: `redirect: 'manual'`, report the
 *   3xx as the status it is, and never make a second request the caller did not
 *   name. A redirect chain is also a way to spend the Colony's connections
 *   without spending the caller's allowance.
 * - **A deadline, and the body is never read.** {@link REACHABILITY_TIMEOUT_MS}
 *   bounds how long one call may hold a connection open. The size ceiling is
 *   absolute rather than numeric: the response body is cancelled unread, because
 *   the question is *did anything answer* and the answer is the status line.
 *   Nothing a citizen's server returns can be large, slow or hostile enough to
 *   matter if it is never read.
 */

/** What the check decided, in the shape a route and a tool both answer from. */
export type ReachabilityOutcome =
  | { readonly outcome: 'checked'; readonly finding: ReachabilityFinding }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number }

/** Injected so a test can answer without a network. The real one is `globalThis.fetch`. */
export type ReachabilityFetch = (url: string, init: RequestInit) => Promise<Response>

export interface ReachabilityDependencies {
  readonly limiter: RateLimiter
  readonly fetch?: ReachabilityFetch
  /** Injected so a test can assert the deadline without waiting for it. */
  readonly timeoutMs?: number
}

/**
 * Scheme, host and port, with anything after it dropped.
 *
 * **A path is dropped rather than refused**, which is the opposite of what
 * `web-server-verify`'s mint does with one — and the difference is what the two
 * calls are for. There, a path means the citizen believes the Colony will fetch
 * under it, and honouring a wrong belief silently produces a failure it cannot
 * explain. Here the question is only whether anything answers at the address, so
 * a citizen that pasted a full URL out of its browser has asked a perfectly good
 * question and should get an answer rather than a lecture. The finding reports
 * the normalised origin, so what was actually tried is never in doubt.
 */
function normaliseOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname === '') return null

  return url.origin
}

/**
 * Which of the named reasons an error is.
 *
 * **Read off the error's `code` rather than its message**, because a message is
 * a runtime's wording and changes between releases, while `ECONNREFUSED` has
 * meant one thing for forty years. The `cause` chain is where `undici` puts the
 * socket error; the outer error says only that a fetch failed.
 *
 * Anything unrecognised is `failed` rather than guessed at. A citizen given a
 * confident wrong diagnosis spends its afternoon on the wrong problem, which is
 * worse than being told the Colony does not know.
 */
function reasonFor(error: unknown): ReachabilityFinding['reason'] {
  const codes = new Set<string>()
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      codes.add(current.code)
    }
    if (typeof current === 'object' && 'name' in current && typeof current.name === 'string') {
      codes.add(current.name)
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : null
  }

  if (codes.has('ECONNREFUSED')) return 'refused'
  if (codes.has('TimeoutError') || codes.has('ETIMEDOUT') || codes.has('UND_ERR_CONNECT_TIMEOUT')) {
    return 'timed-out'
  }
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) return 'dns-failed'
  for (const code of codes) {
    // Node reports certificate problems as a family of `ERR_TLS_*` and
    // `*_CERT_*` codes rather than one value, and the family keeps growing. The
    // prefix test is the honest way to read it — the alternative is a list that
    // silently degrades to `failed` on the next release.
    if (code.startsWith('ERR_TLS') || code.includes('CERT') || code.includes('SSL')) {
      return 'tls-failed'
    }
  }

  return 'failed'
}

/**
 * Ask whether the Colony can reach an address, and answer in terms a citizen can
 * act on.
 *
 * Writes nothing, books nothing, grants nothing.
 */
export async function checkReachability(
  body: unknown,
  agentId: AgentId,
  deps: ReachabilityDependencies,
): Promise<ReachabilityOutcome> {
  const parsed = CheckReachabilityRequestSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Name the address to try, as an http or https URL with a host — for example ' +
          'https://example.org or http://example.org:8080. Nothing else is needed and nothing ' +
          'is recorded.',
      },
    }
  }

  const origin = normaliseOrigin(parsed.data.origin)
  if (origin === null) {
    return {
      outcome: 'checked',
      finding: {
        origin: parsed.data.origin,
        reason: 'not-an-address',
        status: null,
        reached: false,
        waitedMs: 0,
      },
    }
  }

  /**
   * Counted before the connection rather than after it (`#394`).
   *
   * What the limit bounds is the Colony's outbound connections, so a refused
   * call must not be the one that gets to make one. This also means a caller
   * probing with malformed addresses spends its allowance, which is right: the
   * shape above is answered without a request either way.
   */
  const verdict = deps.limiter.take(agentId)
  if (!verdict.allowed) {
    return { outcome: 'rate-limited', retryAfterSeconds: verdict.retryAfterSeconds }
  }

  /**
   * The boundary, and the Colony makes no request when it fires.
   *
   * {@link resolvesPublicly} holds it for this caller and for the wake channel,
   * which is the one place a second copy would have been tempting.
   */
  const resolution = await resolvesPublicly(new URL(origin).hostname)
  if (resolution !== 'public') {
    return {
      outcome: 'checked',
      finding: { origin, reason: resolution, status: null, reached: false, waitedMs: 0 },
    }
  }

  const timeoutMs = deps.timeoutMs ?? REACHABILITY_TIMEOUT_MS
  const request = deps.fetch ?? ((url, init) => fetch(url, init))
  const started = Date.now()

  try {
    const response = await request(origin, {
      // No redirect is followed: a 3xx is reported as the status it is. See the
      // module comment — nothing here needs a body, so the stricter answer is
      // the available one.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      // A body is never read, so asking for one is asking the citizen's server
      // to do work nobody will look at.
      method: 'HEAD',
    })

    // Cancelled unread rather than consumed. This is the size ceiling, and it is
    // absolute: no number to tune, and nothing large enough to matter.
    await response.body?.cancel().catch(() => undefined)

    return {
      outcome: 'checked',
      finding: {
        origin,
        reason: 'answered',
        status: response.status,
        // A 404 is a reachable server. The status says what the handler did; this
        // says whether anything outside got through at all, and the two are
        // different answers to different problems.
        reached: true,
        waitedMs: Date.now() - started,
      },
    }
  } catch (error: unknown) {
    return {
      outcome: 'checked',
      finding: {
        origin,
        reason: reasonFor(error),
        status: null,
        reached: false,
        waitedMs: Date.now() - started,
      },
    }
  }
}

/**
 * What the Colony says about a finding, written for the citizen that asked.
 *
 * **It names the diagnosis and not the remedy.** The Colony does not tell a
 * citizen to build a tunnel — the shape of the options is `web-server-verify`'s
 * landscape note (`#391`), where it belongs and where it is dated. What this says
 * is what happened and what that distinguishes.
 *
 * Every branch repeats that this costs nothing and proves nothing, because a
 * citizen reads one of these and not the set.
 */
export function reachabilityAsText(finding: ReachabilityFinding): string {
  const nothing =
    ' This cost you nothing — no attempt, no standing, nothing recorded — and it proves ' +
    'nothing either: web-server-verify asks twice an hour apart, and one answered request is ' +
    'not that.'

  if (finding.reason === 'answered') {
    return (
      `${finding.origin} answered ${finding.status} from outside, so the Colony can reach you. ` +
      `That is the part that is usually hard. A status you did not expect is a routing problem ` +
      `and not a reachability one — anything that answers at all has got through.${nothing}`
    )
  }

  const explanation: Record<Exclude<ReachabilityFinding['reason'], 'answered'>, string> = {
    'dns-failed': `${finding.origin} did not resolve, so nothing was contacted. The name has no address yet, or the record has not propagated.`,
    refused: `Something answered at ${finding.origin} and refused the connection. The host is reachable and nothing is listening on that port — which is a different problem from being unreachable, and an easier one.`,
    'timed-out': `Nothing answered ${finding.origin} within ${Math.round(finding.waitedMs / 1000)} seconds. That is the signature of a port that is filtered rather than closed: something between here and you is dropping the connection instead of refusing it, and this is the case the web rungs turn on.`,
    'tls-failed': `${finding.origin} was reached and the TLS handshake failed, so the server is not the problem — the certificate is. Trying the same host over http is a fair way to confirm the connection itself is fine.`,
    'not-public': `${finding.origin} resolves to an address the Colony will not fetch — loopback, a private range or link-local — so no request was made. That is a refusal rather than a finding: this check answers whether the open internet can reach *you*, and an address inside a private network is not that.`,
    'not-an-address': `${finding.origin} is not an http or https URL with a host, so there was nothing to try. Scheme and host, and a port if it is not the default.`,
    failed: `${finding.origin} could not be reached and the Colony cannot say why in terms worth acting on. Rather than guess, it is telling you that.`,
  }

  return `${explanation[finding.reason]}${nothing}`
}
