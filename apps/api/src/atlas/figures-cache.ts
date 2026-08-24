import type { AtlasFigures } from '@kolonie-ai/core'

/**
 * How long a cached answer survives with nothing invalidating it (`#1629`).
 *
 * **A backstop and not the mechanism.** Everything below prefers explicit
 * invalidation, because a TTL alone means the Atlas is knowingly wrong for its
 * length and nobody can say which length is acceptable without measuring what
 * changes. What the timer is for is the invalidation nobody wired — and there
 * are two of those on purpose, named in {@link atlasFiguresCache}, because they
 * happen in a different operating-system process and an in-memory cache cannot
 * hear them.
 *
 * **Sixty seconds, because the Colony already publishes a looser promise.** The
 * Atlas pages leave the origin under
 * `cache-control: public, max-age=300, s-maxage=300`, and `kolonie-infra#235`
 * put a Cloudflare rule in front of them that honours it. So a browser is
 * already told these numbers may be five minutes old; a figure that heals within
 * one is strictly fresher than what is already served, and nothing downstream
 * can tell the difference.
 *
 * **Whether the timer should be an event was asked and answered: D-139**
 * (`#1641`). `LISTEN`/`NOTIFY` on the tables the two out-of-process runners write
 * would let them invalidate this the way the decorators do. It is not built, and
 * the argument is not *it would be hard* — it is that **a listener that dies
 * silently is a cache that is stale until a restart, so this constant stays
 * whatever happens.** The trade is therefore a timer against a timer plus schema
 * in two tables and a connection to supervise, bought to shrink a window that is
 * already below what the edge serves.
 *
 * The rates that make it a rounding error, measured 2026-08-24: the verifier
 * runner moves `proved` **twice a day** (14 in seven), and walk-prose moderation
 * follows the walk rate at **3–132 a day**, one every eleven minutes at peak. The
 * record names the three numbers that would reopen it.
 */
export const ATLAS_FIGURES_TTL_MS = 60_000

/**
 * What was measured about every catalogue entry, computed once and reused
 * (`#1629`).
 *
 * ## Why this exists
 *
 * `atlasFigures` is one SQL statement 644 lines long, and it is the whole cost
 * of the Atlas. Measured against production 2026-08-22, the whole-corpus read
 * takes **~6.5 seconds** and was recomputed from scratch on every call — every
 * page, every console read, and every `kolonie.accounts.recipes` naming no
 * provider. Walking the catalogue over MCP put Postgres at **207 % CPU** with
 * three to five copies of the query running at once.
 *
 * **The Cloudflare rule does not cover this.** It caches `kolonie.ai/atlas*` for
 * browsers and takes those pages from 6.8 s to 0.09 s; `mcp.kolonie.ai` does not
 * pass through it, and must not — an MCP answer is computed for the citizen that
 * asked. So the misses the edge never sees are the ones that were hurting.
 *
 * ## Two properties, and the second is the one that fixed the CPU
 *
 * **Compute once and reuse until invalidated**, which is what a cache is. And
 * **one computation per key at a time**: a miss stores the *promise*, so five
 * concurrent callers share one query rather than starting five. That is the
 * burst directly — three to five copies at once was not five cache misses in a
 * row, it was five misses in the same instant, and a cache that only memoises
 * results does nothing about it.
 *
 * ## What must stay true
 *
 * **Two readers must never see different numbers for the same provider** because
 * one hit a warm entry and the other did not. So an entry is replaced whole and
 * never patched, and {@link AtlasFiguresCache.invalidate} drops every key rather
 * than reasoning about which one a write touched — a write that moved a
 * provider's counts moved them for every audience and every direction that can
 * see that provider, and getting that wrong is a wrong number rather than a slow
 * page.
 *
 * **A cold process computes rather than serving nothing.** There is no
 * background warm and no empty first answer; the first caller waits for the
 * query and everybody behind it waits on the same promise.
 *
 * **A failed computation is not cached.** The in-flight promise is dropped on
 * rejection, so a transient database error costs one request rather than
 * poisoning the key until the TTL runs out.
 */
export interface AtlasFiguresCache {
  /**
   * The figures for one key, computed if they are not held.
   *
   * `compute` is called at most once per key per generation, however many
   * callers arrive while it is running.
   */
  read(
    key: string,
    compute: () => Promise<readonly AtlasFigures[]>,
  ): Promise<readonly AtlasFigures[]>
  /**
   * Drop everything held, because something changed underneath it.
   *
   * **Whole and not per key.** See the note above: one write can move one
   * provider's row for every audience and direction at once.
   */
  invalidate(): void
  /** Hits, misses and invalidations since the process started — for a log line. */
  readonly counts: {
    readonly hits: number
    readonly misses: number
    readonly invalidations: number
    readonly expiries: number
  }
}

interface Held {
  readonly at: number
  readonly figures: Promise<readonly AtlasFigures[]>
}

export function atlasFiguresCache(
  options: {
    /** How long an entry survives untouched. {@link ATLAS_FIGURES_TTL_MS} by default. */
    readonly ttlMs?: number
    /** The clock, so a test does not have to wait a minute to prove the backstop. */
    readonly now?: () => number
  } = {},
): AtlasFiguresCache {
  const ttlMs = options.ttlMs ?? ATLAS_FIGURES_TTL_MS
  const now = options.now ?? (() => Date.now())

  const held = new Map<string, Held>()
  const counts = { hits: 0, misses: 0, invalidations: 0, expiries: 0 }

  return {
    read(key, compute) {
      const found = held.get(key)

      if (found !== undefined) {
        if (now() - found.at < ttlMs) {
          counts.hits++

          return found.figures
        }

        counts.expiries++
        held.delete(key)
      }

      counts.misses++

      /**
       * **Stored before it resolves**, which is the whole of the single-flight
       * property: a second caller arriving mid-query finds this entry and awaits
       * the same promise rather than starting a second one.
       */
      const figures = compute()

      held.set(key, { at: now(), figures })

      /**
       * A rejection removes the entry rather than leaving a poisoned promise
       * behind — but only if it is still *this* entry, since an invalidation may
       * have replaced it while the query was running. Re-thrown, so the caller
       * sees the failure it would have seen without a cache.
       */
      return figures.catch((error: unknown) => {
        if (held.get(key)?.figures === figures) held.delete(key)

        throw error
      })
    },
    invalidate() {
      if (held.size === 0) return

      counts.invalidations++
      held.clear()
    },
    counts,
  }
}

/**
 * The key an options object caches under (`#1629`).
 *
 * **Audience and direction, because they are the only two arguments that change
 * the answer for a whole-corpus read.** The audience is in it for a correctness
 * reason rather than a completeness one: the suppression floor is applied inside
 * the query, so what is cached is post-floor, and an entry computed for a
 * provider audience must never be handed to a public reader.
 *
 * **Reads that name a provider are not cached at all** and never reach this —
 * see the guard in `databaseProviderRecipes`. A narrowed read is already
 * milliseconds since `#1627`, and keying on the provider too would put 224
 * entries in here to save nothing.
 */
export function atlasFiguresKey(options: {
  readonly audience?: string
  readonly direction?: string
}): string {
  return `${options.audience ?? 'public'}\u0000${options.direction ?? ''}`
}
