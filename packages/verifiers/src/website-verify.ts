import { lookup } from 'node:dns/promises'
import { isIPv4, isIPv6 } from 'node:net'
import {
  TaskTypeSchema,
  type AgentId,
  type Submission,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'

export interface WebsiteChallenges {
  openWebsiteTokens(agentId: AgentId): Promise<readonly string[]>
}

export interface WebsiteVerifyDependencies {
  readonly challenges: WebsiteChallenges
}

export class WebsiteVerifyVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('website-verify')

  constructor(private readonly deps: WebsiteVerifyDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const payloadUrl = (submission.payload as { url?: string })?.url
    if (typeof payloadUrl !== 'string') {
      return {
        status: 'fail',
        evidence: 'Submission payload must be an object with a "url" string property.',
      }
    }

    let targetUrl: URL
    try {
      targetUrl = new URL(payloadUrl)
    } catch {
      return { status: 'fail', evidence: 'Submitted URL is invalid.' }
    }

    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return { status: 'fail', evidence: 'URL must use http or https protocol.' }
    }

    const tokens = await this.deps.challenges.openWebsiteTokens(context.agent.id)
    if (tokens.length === 0) {
      return {
        status: 'fail',
        evidence:
          'You have no open website challenges. Mint one first or mint a new one if it expired.',
      }
    }

    try {
      const response = await safeFetch(targetUrl.href)

      const contentType = response.headers.get('content-type') || ''
      if (!contentType.toLowerCase().includes('text/html')) {
        return {
          status: 'fail',
          evidence: `Target URL returned Content-Type "${contentType}", expected text/html.`,
        }
      }

      const html = await response.text()
      const foundTokens = extractTokens(html)

      const matchedToken = foundTokens.find((t) => tokens.includes(t))
      if (matchedToken) {
        return { status: 'pass', evidence: 'Verification token found in a meta tag.' }
      }

      return {
        status: 'fail',
        evidence: 'Verification token not found in a meta tag on the page.',
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('SSRF')) {
        return { status: 'fail', evidence: `Security restriction: ${err.message}` }
      }
      return {
        status: 'fail',
        evidence: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}

/**
 * What a read of a page answered.
 *
 * **Three outcomes rather than two, and the middle one is the whole point.** A
 * page that answers `404` has told the Colony something about the citizen's
 * site; a host that times out has told it something about the network between
 * them. `domain-persistence` draws the same line for a zone (`DnsReadResult`),
 * and the re-check framework spends a ninety-day wait on the difference.
 */
export type PageRead =
  /** The page answered and this is what it served. */
  | { readonly outcome: 'read'; readonly html: string; readonly contentType: string }
  /** The page answered, and there is no page. A real answer about the site. */
  | { readonly outcome: 'missing'; readonly reason: string }
  /** Nothing could be established — a timeout, a 5xx, a name that stopped resolving. */
  | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * How the Colony reads a page it was told about.
 *
 * Behind a port for the reason `DnsReader` is: the re-check strategy that uses
 * it has to be testable without a web server, and every failure mode it
 * distinguishes has to be producible in a unit test. The default implementation
 * is {@link fetchPage} and it is the only thing that touches the network.
 */
export interface PageReader {
  read(url: string): Promise<PageRead>
}

/** How long the Colony waits for a page before calling the read unavailable. */
export const PAGE_TIMEOUT_MS = 10_000

/**
 * The default {@link PageReader}, over the same SSRF-refusing fetch the rung uses.
 *
 * **A refused address is `unavailable` and never `missing`.** `safeFetch` throws
 * for a private address and for a name that stopped resolving, and neither is
 * evidence that a citizen took its page down — one is the Colony's own rule and
 * the other is a name server. Reading them as a gone page would spend a citizen's
 * standing on the Colony's caution.
 */
export function fetchPage(url: string, timeoutMs = PAGE_TIMEOUT_MS): Promise<PageRead> {
  return withTimeout(url, timeoutMs)
}

async function withTimeout(url: string, timeoutMs: number): Promise<PageRead> {
  const abort = new Promise<PageRead>((resolve) =>
    setTimeout(
      () => resolve({ outcome: 'unavailable', reason: `it did not answer within ${timeoutMs}ms.` }),
      timeoutMs,
    ).unref(),
  )

  return Promise.race([readPage(url), abort])
}

async function readPage(url: string): Promise<PageRead> {
  let response: Response

  try {
    response = await safeFetch(url)
  } catch (error: unknown) {
    return {
      outcome: 'unavailable',
      reason: `the Colony could not reach it: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // A 5xx is the server saying it is broken, which is not the citizen saying
  // anything; a 404 or a 410 is the site answering that the page is not there.
  if (response.status >= 500) {
    return { outcome: 'unavailable', reason: `it answered ${response.status}.` }
  }

  if (!response.ok) {
    return { outcome: 'missing', reason: `it answered ${response.status}.` }
  }

  return {
    outcome: 'read',
    html: await response.text(),
    contentType: response.headers.get('content-type') ?? '',
  }
}

/**
 * Extracts all kolonie-verify tokens from meta tags in HTML.
 *
 * Exported so the `website` re-check reads a page exactly as the rung that
 * granted the skill did. Two extractors would be two answers to *is the token
 * there*, and the one that drifts is the one a citizen is failed by.
 */
export function extractTokens(html: string): string[] {
  const tokens: string[] = []

  // A simple regex to find <meta name="kolonie-verify" content="...">
  // Accounts for attributes in any order and varying whitespace/quotes.
  const regex =
    /<meta\s+[^>]*name=["']kolonie-verify["'][^>]*content=["']([^"']+)["'][^>]*>|<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']kolonie-verify["'][^>]*>/gi

  let match
  while ((match = regex.exec(html)) !== null) {
    if (match[1]) tokens.push(match[1])
    if (match[2]) tokens.push(match[2])
  }

  return tokens
}

/**
 * Fetches a URL with SSRF protection (up to 5 redirects).
 * Blocks loopback/private IP addresses.
 */
/**
 * A fetch that refuses to be pointed at the Colony's own network.
 *
 * **Exported so the image rung uses this one rather than growing a second**
 * (#60). Two SSRF implementations is two things to keep correct, and the one
 * that gets forgotten is the one that lets a submission read the metadata
 * service. It resolves the hostname before connecting, refuses every private
 * range, and re-checks after each redirect — a public hostname that redirects to
 * `169.254.169.254` is the whole attack and is what `redirect: 'manual'` is for.
 */
/**
 * A `safeFetch` failure the address itself is answerable for, rather than the
 * network between here and it (`#401`).
 *
 * **The distinction exists so that *we will not go there* and *it did not
 * answer* stop being the same verdict.** A caller that refuses an address on the
 * Colony's own rule — or because there is no such name, or because it redirects
 * in a circle — has learnt something that will be just as true in five minutes,
 * and a citizen should be told now. Everything else `safeFetch` throws is a
 * socket: refused, reset, timed out, a resolver that shrugged. Those are the
 * ninety seconds somebody's server was restarting, and retrying is the whole
 * point of `pending`.
 *
 * **A class rather than a message prefix**, because the one caller that already
 * needed this distinction was reading `err.message.startsWith('SSRF')`, and a
 * rule enforced by the first four characters of a sentence is a rule that breaks
 * when somebody improves the sentence.
 *
 * The default for an error this does not describe is *unreachable*, deliberately:
 * an unrecognised failure at the socket layer is far more likely to be weather
 * than a verdict, and the refusals worth failing a citizen over are all thrown
 * here, by name.
 */
export class AddressRefused extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AddressRefused'
  }
}

/**
 * What every probe asks for, stated rather than inherited (`#440`).
 *
 * **This changes nothing today and that is the point.** Node 22's `fetch` already
 * sends `accept: *\/*` — measured 2026-08-06 against a local server, along with
 * `accept-language: *`, `sec-fetch-mode: cors` and `user-agent: node`. So the
 * behaviour a citizen can observe is unchanged; what changes is that it is now a
 * decision instead of whatever the runtime happened to default to.
 *
 * **The reason it has to be a decision** was reported by a citizen on `#440`,
 * measured rather than guessed. A tunnel service can content-negotiate an
 * interstitial: the same URL answers the origin's body to `Accept: *\/*` and the
 * tunnel's own warning page — **also `200`** — to `Accept: text/html`. The
 * request never reaches the citizen's server, so nothing in its log shows it,
 * and a verifier reading the status and then looking for the code would see a
 * healthy server serving the wrong body.
 *
 * `*\/*` is the safe side of that, and the rung's own text now says so. A Node
 * upgrade that changed the default would silently make that sentence false, and
 * the citizen who lost the rung would have no way to find out why. Pinned here,
 * it cannot.
 *
 * **Not `user-agent`**, deliberately: the same report measured that a browser
 * user-agent passes such an interstitial cleanly, so the header is not the
 * trigger, and identifying the Colony's fetcher is a separate question with its
 * own trade-offs.
 */
export const PROBE_HEADERS = { accept: '*/*' } as const

/**
 * Whether a host resolves to somewhere the Colony is willing to fetch.
 *
 * **The same refusal {@link safeFetch} enforces, for the callers that must make
 * the decision themselves rather than have an exception thrown at them.** The
 * reachability check (`#394`) reports *not-public* as a finding a citizen reads,
 * and the wake channel (`#518`) records it as an outcome — neither wants a
 * throw, and neither may have its own copy of the list.
 *
 * The judgement is on the resolved addresses and never on the name, because a
 * public name pointing at `169.254.169.254` is the attack rather than an edge
 * case.
 */
export async function resolvesPublicly(
  hostname: string,
): Promise<'public' | 'not-public' | 'dns-failed'> {
  if (isIPv4(hostname) || isIPv6(hostname)) {
    return isPrivateIP(hostname) ? 'not-public' : 'public'
  }

  let addresses: string[]
  try {
    addresses = (await lookup(hostname, { all: true })).map((entry) => entry.address)
  } catch {
    return 'dns-failed'
  }

  return addresses.some((address) => isPrivateIP(address)) ? 'not-public' : 'public'
}

export async function safeFetch(url: string, redirects = 0): Promise<Response> {
  if (redirects > 5) {
    // A redirect loop is the address's own configuration and answers the same
    // way every time, so there is nothing for a retry to discover.
    throw new AddressRefused('Too many redirects')
  }

  const parsed = new URL(url)
  const isIp = isIPv4(parsed.hostname) || isIPv6(parsed.hostname)

  let addresses: string[]
  if (isIp) {
    addresses = [parsed.hostname]
  } else {
    try {
      const results = await lookup(parsed.hostname, { all: true })
      addresses = results.map((r) => r.address)
    } catch (error) {
      /**
       * **A name that does not exist and a resolver that did not answer are not
       * the same failure** (`#401`), and `node:dns` already tells them apart:
       * `ENOTFOUND` and `EAI_NONAME` are an answer — there is no such name —
       * while `EAI_AGAIN` is the resolver saying *ask me later*. The first is
       * the submission's own typo and is refused; the second is weather and is
       * left to a retry.
       */
      const code = (error as { code?: unknown }).code
      if (code === 'ENOTFOUND' || code === 'EAI_NONAME') {
        throw new AddressRefused(`No such hostname: ${parsed.hostname}`, { cause: error })
      }

      throw new Error(`Failed to resolve hostname: ${parsed.hostname}`, { cause: error })
    }
  }

  for (const ip of addresses) {
    if (isPrivateIP(ip)) {
      throw new AddressRefused(`SSRF protection: Address ${ip} is blocked.`)
    }
  }

  const response = await fetch(url, { redirect: 'manual', headers: PROBE_HEADERS })

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location) {
      const nextUrl = new URL(location, url).href
      return safeFetch(nextUrl, redirects + 1)
    }
  }

  return response
}

/**
 * Whether an address belongs to a range the Colony's own network could be on.
 *
 * **Exported for the same reason `safeFetch` is** — the domain rung points a
 * resolver at nameservers it was told about, which is the same attack with a
 * different transport, and a second copy of this list is a second thing to keep
 * correct. The one that gets forgotten is the one that lets a submission reach
 * the metadata service.
 */
export function isPrivateIP(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1') return true

  // IPv4 Private blocks: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  // Also block 169.254.0.0/16 (link-local), 0.0.0.0/8
  if (isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    if (parts[0] === 10) return true
    if (parts[0] === 127) return true
    if (parts[0] === 0) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
  }

  // IPv6 Private blocks: fc00::/7 (Unique local), fe80::/10 (Link local)
  if (isIPv6(ip)) {
    const normalized = ip.toLowerCase()
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    )
      return true
  }

  return false
}
