import { promises as dns } from 'node:dns'

function isPrivateIP(ip: string): boolean {
  if (ip === '::1') return true
  if (ip.includes(':')) {
    // Basic IPv6 private checks: fc00::/7, fe80::/10
    const lower = ip.toLowerCase()
    if (
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    ) {
      return true
    }
    return false
  }

  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return false

  const [a, b] = parts

  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 127.0.0.0/8
  if (a === 169 && b! === 254) return true // 169.254.0.0/16
  if (a === 172 && b! >= 16 && b! <= 31) return true // 172.16.0.0/12
  if (a === 192 && b! === 168) return true // 192.168.0.0/16

  return false
}

export async function validateAvatarUrl(urlStr: string): Promise<string | null> {
  let currentUrl = urlStr
  let redirects = 0

  try {
    while (redirects <= 5) {
      let parsed: URL
      try {
        parsed = new URL(currentUrl)
      } catch {
        return 'URL format is invalid.'
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'URL must be http or https.'
      }

      if (!parsed.hostname) {
        return 'URL must have a hostname.'
      }

      // Check IP
      let address: string
      try {
        const lookup = await dns.lookup(parsed.hostname)
        address = lookup.address
      } catch {
        return 'Hostname could not be resolved.'
      }

      if (isPrivateIP(address)) {
        return 'URL resolves to a private or local address.'
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)

      let res: Response
      try {
        res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Kolonie-Agent-Profile-Validator/1.0',
          },
        })
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') {
          return 'Request timed out.'
        }
        return 'Failed to fetch URL.'
      } finally {
        clearTimeout(timeout)
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location')
        if (!location) {
          return 'Redirected without a location header.'
        }
        currentUrl = new URL(location, currentUrl).toString()
        redirects++
        continue
      }

      if (!res.ok) {
        return `URL returned HTTP ${res.status}.`
      }

      const contentType = res.headers.get('content-type')
      if (!contentType || !contentType.toLowerCase().startsWith('image/')) {
        return 'URL does not point to an image (Content-Type must be image/*).'
      }

      const contentLength = res.headers.get('content-length')
      if (contentLength) {
        const size = parseInt(contentLength, 10)
        if (!isNaN(size) && size > 5 * 1024 * 1024) {
          return 'Image size must be under 5MB.'
        }
      }

      return null // Valid
    }

    return 'Too many redirects.'
  } catch {
    return 'An unexpected error occurred while validating the URL.'
  }
}
