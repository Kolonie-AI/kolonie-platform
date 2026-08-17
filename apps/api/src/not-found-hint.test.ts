import { describe, expect, it } from 'vitest'
import type { RegisteredRoute } from './openapi/document.js'
import { nearestRouteHint } from './not-found-hint.js'

/**
 * `#1129`. The route table is the fixture, because that is the whole claim:
 * these sentences are derived from what Fastify registered, so a table written
 * here is the honest way to ask what they say about a given shape.
 */
const routes: RegisteredRoute[] = [
  { method: ['GET', 'HEAD'], url: '/v1/vault' },
  { method: 'PUT', url: '/v1/vault/:key' },
  { method: 'GET', url: '/v1/vault/:key' },
  { method: 'DELETE', url: '/v1/vault/:key' },
  { method: 'PUT', url: '/v1/vault/:key/description' },
  { method: 'GET', url: '/v1/tasks' },
  { method: 'GET', url: '/v1/tasks/:taskId' },
  { method: 'GET', url: '/v1/citizens/:name' },
  { method: 'POST', url: '/v1/console/session' },
  { method: 'GET', url: '/v1/steward/queue' },
]

describe('nearestRouteHint', () => {
  /**
   * The `kolonie-docs#425` case, and the reason the issue was written: the
   * caller sent the recommended vault key shape, which has a `/` in it, and got
   * back a sentence naming the path it had just sent.
   */
  it('names the pattern when a parameter was handed more than one segment', () => {
    const hint = nearestRouteHint('PUT', '/v1/vault/phone/agentphone.ai/assay', routes)

    expect(hint).toContain('/v1/vault/{key}')
    expect(hint).toContain('{key}` is one segment')
    expect(hint).toContain('%2F')
  })

  it('names the methods when the path is registered and the method is not', () => {
    const hint = nearestRouteHint('POST', '/v1/vault/abc', routes)

    expect(hint).toBe(
      'The path is registered as `/v1/vault/{key}`, ' +
        'which answers DELETE, GET, PUT rather than POST.',
    )
  })

  it('says a segment is missing when the caller stopped one short', () => {
    expect(nearestRouteHint('PUT', '/v1/vault/abc/', routes)).toBe(
      'The nearest registered route is `/v1/vault/{key}/description`, ' +
        'which takes one more segment.',
    )
  })

  it('names the route when one segment is misspelled', () => {
    expect(nearestRouteHint('GET', '/v1/task/abc', routes)).toBe(
      'The nearest registered route is `/v1/tasks/{taskId}`.',
    )
  })

  /**
   * The bound on the last case. Without it, *one literal differs* matches every
   * three-segment route at once and the sentence names three unrelated paths,
   * one of which happens to be right.
   */
  it('says nothing when no registered route is close', () => {
    expect(nearestRouteHint('GET', '/v1/wardrobe/abc', routes)).toBeUndefined()
    expect(nearestRouteHint('GET', '/nope', routes)).toBeUndefined()
    expect(nearestRouteHint('GET', '/', routes)).toBeUndefined()
  })

  /**
   * A 404 body is read before any credential is checked. The private prefixes
   * are absent from `/openapi.json` for that reason and are absent here for the
   * same one — a caller mistyping a steward path gets the plain 404.
   */
  it('never names a route a stranger is not invited through', () => {
    expect(nearestRouteHint('GET', '/v1/console/session', routes)).toBeUndefined()
    expect(nearestRouteHint('GET', '/v1/steward/queues', routes)).toBeUndefined()
  })

  /**
   * The property that makes this publishable at all: every comparison is
   * against a `:param` position, which matches any segment, so the sentence
   * cannot depend on whether the value in the URL exists.
   */
  it('answers identically whatever the value in the path is', () => {
    const first = nearestRouteHint('POST', '/v1/vault/github~octocat', routes)
    const second = nearestRouteHint('POST', '/v1/vault/nothing-is-stored-here', routes)

    expect(first).toBe(second)
    expect(first).not.toContain('octocat')
  })

  it('reads the path without its query string', () => {
    expect(nearestRouteHint('POST', '/v1/vault/abc?probe=1', routes)).toContain('/v1/vault/{key}')
  })

  it('ignores HEAD, which Fastify adds to every GET and nobody chooses', () => {
    expect(nearestRouteHint('POST', '/v1/vault', routes)).toBe(
      'The path is registered as `/v1/vault`, which answers GET rather than POST.',
    )
  })
})
