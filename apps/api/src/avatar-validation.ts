import dns from 'node:dns/promises'
import net from 'node:net'
import { request } from 'undici'

export function isPrivateIp(ip: string): boolean {
  if (ip === '::1') return true
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true
  if (
    ip.startsWith('fe8') ||
    ip.startsWith('fe9') ||
    ip.startsWith('fea') ||
    ip.startsWith('feb')
  ) {
    return true
  }

  const parts = ip.split('.').map(Number)
  if (parts.length === 4) {
    if (parts[0] === 10) return true
    if (parts[0] === 127) return true
    if (parts[0] === 0) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) return true
  }

  // Also check IPv4-mapped IPv6 like ::ffff:127.0.0.1
  if (ip.startsWith('::ffff:')) {
    return isPrivateIp(ip.slice(7))
  }

  return false
}

export async function validateAvatarUrl(targetUrl: string): Promise<string | null> {
  let currentUrl = targetUrl
  let redirects = 0

  while (redirects <= 5) {
    let urlObj: URL
    try {
      urlObj = new URL(currentUrl)
    } catch {
      return 'invalid URL format'
    }

    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return 'must be http or https'
    }

    let ip: string
    if (net.isIP(urlObj.hostname)) {
      ip = urlObj.hostname
    } else {
      try {
        const addresses = await dns.resolve(urlObj.hostname)
        if (addresses.length === 0 || addresses[0] === undefined) return 'could not resolve host'
        ip = addresses[0]
      } catch {
        return 'could not resolve host'
      }
    }

    if (isPrivateIp(ip)) {
      return 'URL points to a private IP address'
    }

    try {
      const response = await request(currentUrl, {
        method: 'GET',
        headersTimeout: 10000,
        bodyTimeout: 10000,
      })

      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers['location']
        if (location === undefined) return 'redirect missing location header'
        const nextUrl = new URL(
          Array.isArray(location) ? location[0]! : location,
          currentUrl,
        ).toString()
        // Dump the body of the redirect response
        await response.body.dump()
        currentUrl = nextUrl
        redirects++
        continue
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump()
        return `URL returned status ${response.statusCode}`
      }

      const contentType = response.headers['content-type']
      if (!contentType || !contentType.toString().startsWith('image/')) {
        await response.body.dump()
        return 'Content-Type must be image/*'
      }

      const contentLengthStr = response.headers['content-length']
      if (contentLengthStr) {
        const contentLength = parseInt(contentLengthStr.toString(), 10)
        if (contentLength > 5 * 1024 * 1024) {
          await response.body.dump()
          return 'Content-Length must be under 5MB'
        }
      }

      // Check stream size if we need to be strictly sure it's under 5MB,
      // but if the server lied about Content-Length or omitted it, we should read it safely.
      let totalBytes = 0
      for await (const chunk of response.body) {
        totalBytes += chunk.length
        if (totalBytes > 5 * 1024 * 1024) {
          // Drain the rest and return error to avoid leaving socket hanging
          await response.body.dump()
          return 'Content-Length must be under 5MB'
        }
      }

      return null // Valid
    } catch (e: unknown) {
      const error = e as Error
      if (error.name === 'HeadersTimeoutError' || error.name === 'BodyTimeoutError') {
        return 'URL took too long to respond'
      }
      return 'failed to fetch URL'
    }
  }

  return 'too many redirects'
}
