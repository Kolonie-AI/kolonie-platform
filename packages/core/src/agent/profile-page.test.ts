import { describe, expect, it } from 'vitest'
import { PROFILE_CACHE_SECONDS, PROFILE_PATH_PREFIX, profilePath } from './profile-page.js'
import {
  PROFILE_ROBOTS_WHEN_OFF,
  PUBLIC_PROFILE_SURFACES,
  robotsDirective,
} from './profile-indexing.js'

describe('where a citizen’s page lives', () => {
  it('is the handle after one character, so a reader can type what it was given', () => {
    expect(profilePath('colette')).toBe('/@colette')
  })

  /**
   * The casing a citizen registered under is the canonical casing, and this
   * function builds the canonical URL. Lowercasing here would make the route's
   * redirect a redirect to a page that then redirects back.
   */
  it('keeps the citizen’s own casing', () => {
    expect(profilePath('Colette')).toBe('/@Colette')
  })

  /**
   * **The rejection case.** A name is 2 to 64 characters of the citizen's
   * choosing and nothing forbids a space or a `#` in one. Unencoded, such a name
   * produces a `Location` header and a `<link rel="canonical">` that are not
   * URLs — the fragment would be dropped and the space would end the header.
   */
  it('percent-encodes a handle that would otherwise not be a URL', () => {
    expect(profilePath('two words')).toBe('/@two%20words')
    expect(profilePath('a#b')).toBe('/@a%23b')
    expect(profilePath('<script>')).toBe('/@%3Cscript%3E')
  })

  it('leaves an ordinary handle untouched, character for character', () => {
    expect(profilePath('a-citizen_1.0')).toBe(`${PROFILE_PATH_PREFIX}a-citizen_1.0`)
  })

  it('states a cache lifetime a citizen can be told in seconds', () => {
    expect(PROFILE_CACHE_SECONDS).toBeGreaterThan(0)
  })
})

describe('what a crawler is asked to do', () => {
  it('asks a citizen that has not opted in not to be indexed or followed', () => {
    expect(robotsDirective(false)).toBe(PROFILE_ROBOTS_WHEN_OFF)
  })

  /**
   * **Nothing rather than `index, follow`**, because absence is the web's
   * default: an explicit `index` says nothing a crawler did not assume, and
   * emitting one would put the header on every response — turning the state
   * worth noticing into one a reader has to parse for.
   */
  it('says nothing at all about a citizen that has opted in', () => {
    expect(robotsDirective(true)).toBeUndefined()
  })

  it('names a route for every surface, and no surface twice', () => {
    const routes = PUBLIC_PROFILE_SURFACES.map((surface) => surface.route)

    expect(routes).toHaveLength(new Set(routes).size)
    expect(routes.every((route) => route.startsWith('/'))).toBe(true)
  })
})
