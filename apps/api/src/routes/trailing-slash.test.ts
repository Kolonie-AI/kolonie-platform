import {
  API_BASE_PATH,
  ATLAS_PATH,
  CITIZEN_PATH_PREFIX,
  PROFILE_PATH_PREFIX,
} from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

let app: FastifyInstance

beforeEach(async () => {
  app = buildApp({ ...fakeColony(), websiteUrl: SITE })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { host: SITE_HOST, accept: 'text/html' } })

/**
 * A trailing slash on a public page is a `301` to the page (`#1212`).
 *
 * **The colony is empty and no citizen is registered on purpose.** Every
 * redirect below is asserted against a handle nobody holds, which is what shows
 * the hook answering ahead of the route rather than after a lookup — the
 * property decision 5 in the issue rests on, and the reason `/citizens/x/` costs
 * two hops instead of a database read on every request to these prefixes.
 */
describe('a trailing slash on a public page', () => {
  it.each([
    [`${ATLAS_PATH}/`, ATLAS_PATH],
    [`${ATLAS_PATH}/github.com/`, `${ATLAS_PATH}/github.com`],
    [`${ATLAS_PATH}/c/mailbox/`, `${ATLAS_PATH}/c/mailbox`],
    [`${PROFILE_PATH_PREFIX}colette/`, `${PROFILE_PATH_PREFIX}colette`],
    [`${CITIZEN_PATH_PREFIX}colette/`, `${CITIZEN_PATH_PREFIX}colette`],
  ])('redirects %s permanently to %s', async (asked, expected) => {
    const response = await get(asked)

    expect(response.statusCode).toBe(301)
    expect(response.headers.location).toBe(expected)
  })

  /**
   * The slash is dropped and nothing else is. A redirect that lost the query
   * would send a reader on page two of the shelf back to page one, which is a
   * worse answer than the `404` this replaces.
   */
  it('keeps the query string', async () => {
    const response = await get(`${ATLAS_PATH}/github.com/?page=2`)

    expect(response.headers.location).toBe(`${ATLAS_PATH}/github.com?page=2`)
  })

  /** One hop to the canonical form, not a chain through each slash. */
  it('drops a run of slashes in a single hop', async () => {
    const response = await get(`${PROFILE_PATH_PREFIX}colette//`)

    expect(response.statusCode).toBe(301)
    expect(response.headers.location).toBe(`${PROFILE_PATH_PREFIX}colette`)
  })

  /**
   * **No lifetime, unlike `permanently()` in `profile-pages.ts`.** That one is
   * capped because its `location` carries a citizen's registered casing and must
   * not outlive an erasure. This `location` is the caller's own URL with one
   * character removed and says nothing about anybody, so it is the redirect that
   * should be cached indefinitely — asserted rather than left to be added by
   * somebody making the two look alike.
   */
  it('sets no cache lifetime on the redirect', async () => {
    const response = await get(`${ATLAS_PATH}/`)

    expect(response.headers['cache-control']).toBeUndefined()
  })

  /**
   * A crawler that checks with `HEAD` gets the reader's answer, because Fastify
   * derives a `HEAD` route from every `GET` and the slashed form is therefore
   * reachable both ways.
   */
  it('answers HEAD the same way', async () => {
    const response = await app.inject({
      method: 'HEAD',
      url: `${ATLAS_PATH}/`,
      headers: { host: SITE_HOST },
    })

    expect(response.statusCode).toBe(301)
    expect(response.headers.location).toBe(ATLAS_PATH)
  })
})

/**
 * What the hook must leave alone — the half of `#1212` that decision 1 exists to
 * protect, and the reason this is a hook on three prefixes rather than Fastify's
 * `ignoreTrailingSlash`.
 */
describe('a trailing slash anywhere else', () => {
  /**
   * The property that rules the per-instance option out. `ignoreTrailingSlash`
   * would make a slashed `/v1/` path a synonym for the route beside it — a REST
   * semantic nobody asked for, and one that would have arrived as a side effect
   * of fixing a page.
   *
   * **`/about` and not `/tasks`, because this has to be asked of a route that
   * answers.** Every credentialled path refuses before the router reaches it, so
   * a `401` there says nothing about whether the slash was ignored; `/v1/about`
   * is the one `/v1/` route that answers a caller presenting nothing, which is
   * what makes its slashed form a real question.
   */
  it('leaves the REST API answering the 404 it answers today', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/about/`,
      headers: { host: SITE_HOST },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('not_found')
  })

  /** And the path the issue names, asserted for the one thing it can say. */
  it('does not redirect a credentialled REST path either', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/tasks/`,
      headers: { host: SITE_HOST },
    })

    expect(response.statusCode).not.toBe(301)
  })

  /**
   * A string prefix would sweep these in; a segment boundary cannot. `/atlas/`
   * is matched with its slash and `CITIZEN_PATH_PREFIX` carries its own, which
   * is what keeps a future `/atlaskit` or `/citizenship` out of a redirect it
   * has nothing to do with.
   */
  it.each(['/atlaskit/', '/citizenship/'])('leaves %s alone', async (asked) => {
    const response = await get(asked)

    expect(response.statusCode).not.toBe(301)
  })

  it('leaves the root alone', async () => {
    const response = await get('/')

    expect(response.statusCode).not.toBe(301)
  })

  /**
   * Reading methods only. Redirecting a write would move a body to a URL that
   * never expected one, and a `POST` to a slashed page URL is somebody's client
   * with a bug in it rather than a reader.
   */
  it('leaves a POST alone', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${ATLAS_PATH}/`,
      headers: { host: SITE_HOST },
    })

    expect(response.statusCode).not.toBe(301)
  })
})
