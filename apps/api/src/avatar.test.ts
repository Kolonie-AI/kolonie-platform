import { describe, it, expect, vi } from 'vitest'
import { validateAvatarUrl } from './avatar.js'

// Simple mock for DNS
vi.mock('node:dns', () => {
  return {
    promises: {
      lookup: async (hostname: string) => {
        if (hostname === 'localhost' || hostname === '127.0.0.1') return { address: '127.0.0.1' }
        if (hostname === 'private.com') return { address: '192.168.1.1' }
        if (hostname === 'valid.com') return { address: '8.8.8.8' }
        if (hostname === 'redirect.com') return { address: '8.8.8.8' }
        if (hostname === 'redirect-private.com') return { address: '8.8.8.8' }
        throw new Error('ENOTFOUND')
      },
    },
  }
})

const mockFetch = vi.fn(async (url: string | URL | Request) => {
  const urlStr = url.toString()

  if (urlStr === 'https://valid.com/image.png') {
    return new Response(Buffer.from('fake image data'), {
      status: 200,
      headers: new Headers({
        'Content-Type': 'image/png',
        'Content-Length': '100',
      }),
    })
  }
  if (urlStr === 'https://valid.com/large.png') {
    return new Response(Buffer.from('fake image data'), {
      status: 200,
      headers: new Headers({
        'Content-Type': 'image/png',
        'Content-Length': '6000000', // 6MB
      }),
    })
  }
  if (urlStr === 'https://valid.com/text.txt') {
    return new Response('Not an image', {
      status: 200,
      headers: new Headers({
        'Content-Type': 'text/plain',
        'Content-Length': '12',
      }),
    })
  }
  if (urlStr === 'https://valid.com/not-found.png') {
    return new Response(null, { status: 404 })
  }
  if (urlStr === 'https://redirect.com/start') {
    return new Response(null, {
      status: 301,
      headers: new Headers({ Location: 'https://valid.com/image.png' }),
    })
  }
  if (urlStr === 'https://redirect.com/loop') {
    return new Response(null, {
      status: 302,
      headers: new Headers({ Location: 'https://redirect.com/loop' }),
    })
  }
  if (urlStr === 'https://redirect-private.com/start') {
    return new Response(null, {
      status: 302,
      headers: new Headers({ Location: 'http://127.0.0.1/image.png' }),
    })
  }
  throw new Error('Not mocked')
})

vi.stubGlobal('fetch', mockFetch)

describe('validateAvatarUrl', () => {
  it('accepts a valid image URL', async () => {
    const error = await validateAvatarUrl('https://valid.com/image.png')
    expect(error).toBeNull()
  })

  it('rejects invalid URL formats', async () => {
    expect(await validateAvatarUrl('not-a-url')).toBe('URL format is invalid.')
    expect(await validateAvatarUrl('ftp://valid.com/image.png')).toBe('URL must be http or https.')
  })

  it('rejects private IPs', async () => {
    expect(await validateAvatarUrl('http://localhost/image.png')).toBe(
      'URL resolves to a private or local address.',
    )
    expect(await validateAvatarUrl('http://private.com/image.png')).toBe(
      'URL resolves to a private or local address.',
    )
  })

  it('rejects oversized images', async () => {
    expect(await validateAvatarUrl('https://valid.com/large.png')).toBe(
      'Image size must be under 5MB.',
    )
  })

  it('rejects non-image content types', async () => {
    expect(await validateAvatarUrl('https://valid.com/text.txt')).toBe(
      'URL does not point to an image (Content-Type must be image/*).',
    )
  })

  it('follows redirects to a valid image', async () => {
    expect(await validateAvatarUrl('https://redirect.com/start')).toBeNull()
  })

  it('rejects if a redirect resolves to a private IP', async () => {
    expect(await validateAvatarUrl('https://redirect-private.com/start')).toBe(
      'URL resolves to a private or local address.',
    )
  })

  it('rejects on too many redirects', async () => {
    expect(await validateAvatarUrl('https://redirect.com/loop')).toBe('Too many redirects.')
  })

  it('rejects non-200 responses', async () => {
    expect(await validateAvatarUrl('https://valid.com/not-found.png')).toBe(
      'URL returned HTTP 404.',
    )
  })
})
