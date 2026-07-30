import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateAvatarUrl, isPrivateIp } from './avatar-validation.js'
import { MockAgent, setGlobalDispatcher } from 'undici'
import dns from 'node:dns/promises'

vi.mock('node:dns/promises')

describe('isPrivateIp', () => {
  it('identifies private IPs correctly', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true)
    expect(isPrivateIp('10.0.0.1')).toBe(true)
    expect(isPrivateIp('192.168.1.1')).toBe(true)
    expect(isPrivateIp('172.16.0.1')).toBe(true)
    expect(isPrivateIp('172.31.255.255')).toBe(true)
    expect(isPrivateIp('169.254.0.1')).toBe(true)
    expect(isPrivateIp('0.0.0.0')).toBe(true)

    // IPv6
    expect(isPrivateIp('::1')).toBe(true)
    expect(isPrivateIp('fc00::1')).toBe(true)
    expect(isPrivateIp('fd00::1')).toBe(true)
    expect(isPrivateIp('fe80::1')).toBe(true)
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true)

    // Public IPs
    expect(isPrivateIp('8.8.8.8')).toBe(false)
    expect(isPrivateIp('172.32.0.1')).toBe(false)
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false)
  })
})

describe('validateAvatarUrl', () => {
  let mockAgent: MockAgent

  beforeEach(() => {
    mockAgent = new MockAgent()
    mockAgent.disableNetConnect()
    setGlobalDispatcher(mockAgent)
    vi.mocked(dns.resolve).mockResolvedValue(['8.8.8.8'])
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('rejects invalid format', async () => {
    expect(await validateAvatarUrl('not-a-url')).toBe('invalid URL format')
  })

  it('rejects non-http/https', async () => {
    expect(await validateAvatarUrl('ftp://example.com/image.png')).toBe('must be http or https')
  })

  it('rejects localhost and private IPs before request', async () => {
    vi.mocked(dns.resolve).mockResolvedValue(['127.0.0.1'])
    expect(await validateAvatarUrl('http://localhost/image.png')).toBe(
      'URL points to a private IP address',
    )

    expect(await validateAvatarUrl('http://192.168.1.1/image.png')).toBe(
      'URL points to a private IP address',
    )
  })

  it('accepts a valid image URL', async () => {
    const pool = mockAgent.get('https://example.com')
    pool.intercept({ path: '/image.png', method: 'GET' }).reply(200, 'imagedata', {
      headers: {
        'content-type': 'image/png',
        'content-length': '9',
      },
    })
    expect(await validateAvatarUrl('https://example.com/image.png')).toBeNull()
  })

  it('rejects non-image content type', async () => {
    const pool = mockAgent.get('https://example.com')
    pool.intercept({ path: '/text.txt', method: 'GET' }).reply(200, 'textdata', {
      headers: {
        'content-type': 'text/plain',
        'content-length': '8',
      },
    })
    expect(await validateAvatarUrl('https://example.com/text.txt')).toBe(
      'Content-Type must be image/*',
    )
  })

  it('rejects oversized images via header', async () => {
    const pool = mockAgent.get('https://example.com')
    pool.intercept({ path: '/big.png', method: 'GET' }).reply(200, 'imagedata', {
      headers: {
        'content-type': 'image/png',
        'content-length': (6 * 1024 * 1024).toString(),
      },
    })
    expect(await validateAvatarUrl('https://example.com/big.png')).toBe(
      'Content-Length must be under 5MB',
    )
  })

  it('follows redirects and resolves correctly', async () => {
    const pool1 = mockAgent.get('https://example.com')
    pool1.intercept({ path: '/redirect', method: 'GET' }).reply(302, '', {
      headers: { location: 'https://other.com/image.png' },
    })

    const pool2 = mockAgent.get('https://other.com')
    pool2.intercept({ path: '/image.png', method: 'GET' }).reply(200, 'imagedata', {
      headers: { 'content-type': 'image/jpeg' },
    })

    expect(await validateAvatarUrl('https://example.com/redirect')).toBeNull()
  })

  it('rejects redirect to a private IP', async () => {
    const pool1 = mockAgent.get('https://example.com')
    pool1.intercept({ path: '/redirect', method: 'GET' }).reply(302, '', {
      headers: { location: 'http://10.0.0.1/image.png' },
    })

    expect(await validateAvatarUrl('https://example.com/redirect')).toBe(
      'URL points to a private IP address',
    )
  })

  it('rejects too many redirects', async () => {
    const pool = mockAgent.get('https://example.com')
    for (let i = 0; i <= 5; i++) {
      pool.intercept({ path: `/redirect${i}`, method: 'GET' }).reply(302, '', {
        headers: { location: `/redirect${i + 1}` },
      })
    }

    expect(await validateAvatarUrl('https://example.com/redirect0')).toBe('too many redirects')
  })
})
