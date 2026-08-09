import type { BadgesAwarded } from '@kolonie-ai/db'
import type { SweepSpec } from './loop.js'

/**
 * The two sweeps, and what each of them is worth saying about a pass.
 *
 * Kept out of `main.ts` because `main.ts` is wiring and is not tested: deciding
 * *when this process speaks* is a judgement, and a judgement that lives only in
 * an entry point is one nothing can assert. The database work itself is in
 * `packages/db`, against a real database.
 */

/** Awarding what has newly become true (`#241`). */
export function badgeSweep(sweep: () => Promise<BadgesAwarded>): SweepSpec<BadgesAwarded> {
  return {
    name: 'badges',
    sweep,
    empty: {},
    report: (awarded) =>
      Object.keys(awarded).length === 0
        ? undefined
        : { message: 'badges awarded', fields: { event: 'badges.awarded', awarded } },
  }
}
