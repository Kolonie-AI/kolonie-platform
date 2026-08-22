import { describe, expect, it } from 'vitest'
import type { AtlasFigures } from '@kolonie-ai/core'
import { ATLAS_FIGURES_TTL_MS, atlasFiguresCache, atlasFiguresKey } from './figures-cache.js'

const figures = (provider: string): readonly AtlasFigures[] =>
  [{ provider }] as unknown as readonly AtlasFigures[]

/**
 * The cache in front of the 644-line figures query (`#1629`).
 *
 * **Against a fake compute rather than a database**, because every property that
 * matters here is about *how many times the function is called and when* — which
 * a counter answers exactly and a query answers only by inference.
 */
describe('holding the Atlas figures between reads', () => {
  it('computes on a cold read rather than answering nothing', async () => {
    const cache = atlasFiguresCache()

    expect(await cache.read('public ', () => Promise.resolve(figures('one.test')))).toEqual([
      { provider: 'one.test' },
    ])
    expect(cache.counts.misses).toBe(1)
  })

  it('computes once and reuses it', async () => {
    const cache = atlasFiguresCache()
    let ran = 0
    const compute = () => {
      ran++

      return Promise.resolve(figures('one.test'))
    }

    await cache.read('public ', compute)
    await cache.read('public ', compute)
    await cache.read('public ', compute)

    expect(ran).toBe(1)
    expect(cache.counts).toMatchObject({ hits: 2, misses: 1 })
  })

  /**
   * **The burst, which is what put Postgres at 207 % CPU.** Three to five copies
   * of the query ran at once, and a cache that only memoises the *result* would
   * still have started all five: they all missed in the same instant. What stops
   * it is storing the promise.
   */
  it('runs one query for callers that all arrive before it answers', async () => {
    const cache = atlasFiguresCache()
    let ran = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const compute = async () => {
      ran++
      await gate

      return figures('one.test')
    }

    const all = Promise.all([
      cache.read('public ', compute),
      cache.read('public ', compute),
      cache.read('public ', compute),
      cache.read('public ', compute),
      cache.read('public ', compute),
    ])

    release?.()

    expect((await all).every((one) => one[0]?.provider === 'one.test')).toBe(true)
    expect(ran).toBe(1)
  })

  it('keeps one entry per key', async () => {
    const cache = atlasFiguresCache()

    expect(await cache.read('public ', () => Promise.resolve(figures('a.test')))).toEqual([
      { provider: 'a.test' },
    ])
    expect(await cache.read('public inbound', () => Promise.resolve(figures('b.test')))).toEqual([
      { provider: 'b.test' },
    ])
    expect(await cache.read('public ', () => Promise.resolve(figures('never.test')))).toEqual([
      { provider: 'a.test' },
    ])
  })

  it('recomputes after an invalidation', async () => {
    const cache = atlasFiguresCache()
    let ran = 0
    const compute = () => Promise.resolve(figures(`run-${++ran}.test`))

    expect(await cache.read('public ', compute)).toEqual([{ provider: 'run-1.test' }])
    cache.invalidate()
    expect(await cache.read('public ', compute)).toEqual([{ provider: 'run-2.test' }])
    expect(cache.counts.invalidations).toBe(1)
  })

  /**
   * **Whole and not per key.** One write moves a provider's row for every
   * audience and every direction that can see it, so an invalidation that kept
   * the other keys would leave two readers disagreeing about one provider —
   * which is the one thing this must never do.
   */
  it('drops every key, not the one a reader last used', async () => {
    const cache = atlasFiguresCache()
    let ran = 0
    const compute = () => Promise.resolve(figures(`run-${++ran}.test`))

    await cache.read('public ', compute)
    await cache.read('public outbound', compute)
    cache.invalidate()

    expect(await cache.read('public ', compute)).toEqual([{ provider: 'run-3.test' }])
    expect(await cache.read('public outbound', compute)).toEqual([{ provider: 'run-4.test' }])
  })

  /**
   * The backstop, for the two writers this process cannot hear: the verifier
   * runner proving an account and the moderation runner deciding walk prose.
   */
  it('recomputes on its own once the backstop has passed', async () => {
    let clock = 1_000
    const cache = atlasFiguresCache({ now: () => clock })
    let ran = 0
    const compute = () => Promise.resolve(figures(`run-${++ran}.test`))

    await cache.read('public ', compute)

    clock += ATLAS_FIGURES_TTL_MS - 1
    expect(await cache.read('public ', compute)).toEqual([{ provider: 'run-1.test' }])

    clock += 1
    expect(await cache.read('public ', compute)).toEqual([{ provider: 'run-2.test' }])
    expect(cache.counts.expiries).toBe(1)
  })

  /**
   * A transient database error must cost one request rather than the whole
   * backstop window — a rejected promise left in the map would be handed to
   * every caller for the next minute.
   */
  it('does not hold on to a failed computation', async () => {
    const cache = atlasFiguresCache()
    let ran = 0
    const compute = () => {
      ran++

      return ran === 1
        ? Promise.reject(new Error('connection lost'))
        : Promise.resolve(figures('ok.test'))
    }

    await expect(cache.read('public ', compute)).rejects.toThrow('connection lost')
    expect(await cache.read('public ', compute)).toEqual([{ provider: 'ok.test' }])
  })

  describe('the key', () => {
    it('separates the audiences, because what is cached is post-floor', () => {
      expect(atlasFiguresKey({ audience: 'public' })).not.toBe(
        atlasFiguresKey({ audience: 'provider' }),
      )
    })

    it('separates the directions', () => {
      expect(atlasFiguresKey({ direction: 'inbound' })).not.toBe(
        atlasFiguresKey({ direction: 'outbound' }),
      )
      expect(atlasFiguresKey({})).not.toBe(atlasFiguresKey({ direction: 'both' }))
    })

    it('reads an absent audience as public, which is what the query does', () => {
      expect(atlasFiguresKey({})).toBe(atlasFiguresKey({ audience: 'public' }))
    })
  })
})
