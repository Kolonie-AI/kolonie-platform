import { describe, expect, it } from 'vitest'
import { API_KEY_PREFIX, ApiKeySchema } from '@kolonie-ai/core'
import { API_KEY_ENTROPY_BYTES, apiKeyHashEquals, generateApiKey, hashApiKey } from './api-key.js'

describe('generateApiKey', () => {
  it('issues a key core accepts', () => {
    expect(() => ApiKeySchema.parse(generateApiKey())).not.toThrow()
  })

  it('carries the prefix that makes a leaked key greppable in logs', () => {
    expect(generateApiKey().startsWith(API_KEY_PREFIX)).toBe(true)
  })

  it('never repeats itself', () => {
    const keys = new Set(Array.from({ length: 500 }, () => String(generateApiKey())))
    expect(keys.size).toBe(500)
  })

  it('spends the full entropy budget', () => {
    // base64url of N bytes is ceil(N * 4 / 3) characters, unpadded. Asserting
    // the length is how we notice if someone "tidies up" the byte count: a key
    // that still parses can carry far less randomness than the doc comment
    // claims, and nothing else in the system would complain.
    const encoded = String(generateApiKey()).slice(API_KEY_PREFIX.length)
    expect(encoded.length).toBe(Math.ceil((API_KEY_ENTROPY_BYTES * 4) / 3))
  })

  it('uses no character that changes meaning in a URL or an unquoted shell word', () => {
    for (let i = 0; i < 200; i++) {
      expect(String(generateApiKey())).toMatch(/^kol_[A-Za-z0-9_-]+$/)
    }
  })
})

describe('hashApiKey', () => {
  it('is deterministic — the unique index on secret_hash is the lookup path', () => {
    const key = generateApiKey()
    expect(hashApiKey(key)).toBe(hashApiKey(key))
  })

  it('does not contain the key it came from', () => {
    const key = generateApiKey()
    expect(hashApiKey(key)).not.toContain(String(key).slice(API_KEY_PREFIX.length))
  })

  it('separates two keys that differ in one character', () => {
    const key = String(generateApiKey())
    const nudged = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`
    expect(hashApiKey(key)).not.toBe(hashApiKey(nudged))
  })

  it('produces a fixed-width hex digest, so the column width is stable', () => {
    expect(hashApiKey(generateApiKey())).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('apiKeyHashEquals', () => {
  it('accepts a hash against itself', () => {
    const hash = hashApiKey(generateApiKey())
    expect(apiKeyHashEquals(hash, hash)).toBe(true)
  })

  it('rejects two different hashes', () => {
    expect(apiKeyHashEquals(hashApiKey(generateApiKey()), hashApiKey(generateApiKey()))).toBe(false)
  })

  it('rejects rather than throws when the lengths differ', () => {
    // timingSafeEqual throws on unequal lengths. A caller that passes something
    // which is not a hash must get `false`, not a 500.
    expect(apiKeyHashEquals(hashApiKey(generateApiKey()), 'not-a-hash')).toBe(false)
  })
})
