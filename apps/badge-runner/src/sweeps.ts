import type { BadgesAwarded, RewardedWalk } from '@kolonie-ai/db'
import type { SweepSpec } from './loop.js'

/**
 * The sweeps, and what each of them is worth saying about a pass.
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

/**
 * Paying the walks whose words have reached their readers (`#858`, `#1033`).
 *
 * **It logs the pairs it paid for and never the citizens it paid.** A quiet pass
 * is the ordinary one — most days nothing new clears moderation — and a pass
 * that did pay is worth a line, because *which providers the Atlas learned
 * about* is the number this feature exists to move. Who earned it is on the
 * reputation record, where it belongs, and not in a runner's log.
 *
 * **The outcome is in the line and the amount is not** (`#1033`). Every outcome
 * pays the same now, so a log that said only *paid: 4* would leave the one thing
 * worth watching — whether failed walks are actually being paid — readable
 * nowhere but the database. A pair and its outcome name no citizen.
 */
export function walkRewardSweep(
  sweep: () => Promise<readonly RewardedWalk[]>,
): SweepSpec<readonly RewardedWalk[]> {
  return {
    name: 'walk-rewards',
    sweep,
    empty: [],
    report: (paid) =>
      paid.length === 0
        ? undefined
        : {
            message: 'walk rewards paid',
            fields: {
              event: 'walks.rewarded',
              paid: paid.length,
              providers: paid.map((walk) => `${walk.kind}:${walk.provider}:${walk.outcome}`),
            },
          },
  }
}
