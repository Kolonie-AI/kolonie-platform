import { describe, expect, it } from 'vitest'
import { AVATAR_CACHE_SECONDS } from './profile-page.js'
import {
  longestProfileCacheSeconds,
  PUBLIC_PROFILE_SURFACES,
  robotsDirective,
} from './profile-indexing.js'

/**
 * The registry of public surfaces, and the promise its numbers stand behind
 * (`#828`).
 *
 * What the API asserts is that the routes and this list agree. What is asserted
 * here is the property that has nothing to do with a router: **the longest
 * lifetime in the list is the delay an erasing citizen was promised**, so a
 * seventh surface cached for a day would break `#825`'s receipt rather than only
 * being slow to update.
 */
describe('what a cache may hold about a citizen', () => {
  it('gives every surface a lifetime and a reason', () => {
    for (const surface of PUBLIC_PROFILE_SURFACES) {
      expect(surface.cacheSeconds, surface.surface).toBeGreaterThan(0)
      expect(surface.why.length, surface.surface).toBeGreaterThan(20)
    }
  })

  /**
   * **The rejection case, and the one this file exists for.** The receipt leads
   * with the avatar's hour because it is the longest; a surface added above it
   * would make the receipt quote a number that is no longer the longest, and
   * nothing else in the codebase would notice. Raising this ceiling is allowed —
   * it just cannot be done by accident, because `#825`'s wording moves with it.
   */
  it('holds nothing longer than the delay the erasure receipt promises', () => {
    expect(longestProfileCacheSeconds()).toBe(AVATAR_CACHE_SECONDS)

    for (const surface of PUBLIC_PROFILE_SURFACES) {
      expect(surface.cacheSeconds, surface.surface).toBeLessThanOrEqual(AVATAR_CACHE_SECONDS)
    }
  })

  /**
   * A cached object carries the directive that was on it when it was stored, so
   * the two questions — *how long may this be held* and *what may be done with
   * it* — are answered about the same object and belong in the same file.
   */
  it('asks a crawler for nothing when the citizen has opted in', () => {
    expect(robotsDirective(true)).toBeUndefined()
    expect(robotsDirective(false)).toBe('noindex, nofollow')
  })

  it('names each surface once', () => {
    const names = PUBLIC_PROFILE_SURFACES.map((surface) => surface.surface)
    expect(new Set(names).size).toBe(names.length)
  })
})
