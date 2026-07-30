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

/** Extracts all kolonie-verify tokens from meta tags in HTML. */
function extractTokens(html: string): string[] {
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
async function safeFetch(url: string, redirects = 0): Promise<Response> {
  if (redirects > 5) {
    throw new Error('Too many redirects')
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
    } catch {
      throw new Error(`Failed to resolve hostname: ${parsed.hostname}`)
    }
  }

  for (const ip of addresses) {
    if (isPrivateIP(ip)) {
      throw new Error(`SSRF protection: Address ${ip} is blocked.`)
    }
  }

  const response = await fetch(url, { redirect: 'manual' })

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location) {
      const nextUrl = new URL(location, url).href
      return safeFetch(nextUrl, redirects + 1)
    }
  }

  return response
}

function isPrivateIP(ip: string): boolean {
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
