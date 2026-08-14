import { describe, expect, it } from 'vitest'
import { decodeProfilePath } from './profile-url.js'

/**
 * The rewrite every request passes through (`#902`).
 *
 * `profile-pages.test.ts` asserts what a reader gets; this asserts what the
 * function does to a string, because it runs before routing on every request the
 * process receives and most of them are not profiles at all.
 */
describe('the encoded profile prefix', () => {
  it('turns the encoded prefix into the one the routes are registered under', () => {
    expect(decodeProfilePath('/%40Canary')).toBe('/@Canary')
  })

  it('leaves a path that already uses the raw prefix alone', () => {
    expect(decodeProfilePath('/@Canary')).toBe('/@Canary')
  })

  /**
   * **Once, not a loop.** `/%2540Canary` is the encoded form of `/%40Canary`.
   * Rewriting it would make it a second address for the citizen, and a third
   * round a third — the rest of the path is why this rewrites a fixed prefix
   * rather than decoding anything.
   */
  it('does not rewrite a doubly-encoded prefix', () => {
    expect(decodeProfilePath('/%2540Canary')).toBe('/%2540Canary')
  })

  it('leaves what a handle itself encoded for the router to decode', () => {
    expect(decodeProfilePath('/%40Can%2Fary')).toBe('/@Can%2Fary')
    expect(decodeProfilePath('/%40Canary%40')).toBe('/@Canary%40')
  })

  /**
   * Every `/v1/` call in the Colony goes through this. A prefix elsewhere in the
   * path is not a profile and must survive untouched.
   */
  it.each(['/v1/agents/me', '/citizens/Canary', '/', '/v1/quests/%40Canary', '/atlas/%40'])(
    'passes %s through unchanged',
    (url) => {
      expect(decodeProfilePath(url)).toBe(url)
    },
  )

  it('carries a query string through with the path', () => {
    expect(decodeProfilePath('/%40Canary?from=atlas')).toBe('/@Canary?from=atlas')
  })
})
