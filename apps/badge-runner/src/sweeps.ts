import type { BadgesAwarded, QuestRefund } from '@kolonie-ai/db'
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

/** What one refund pass returned. Mirrors `sweepQuestRefunds`. */
export interface RefundOutcome {
  readonly refunded: readonly QuestRefund[]
  readonly failed: readonly { readonly taskId: string; readonly error: unknown }[]
}

/**
 * Returning capacity nobody filled (`#315`).
 *
 * **Louder than the badge sweep, on purpose.** A pass that refunded something
 * logs every quest and its amount, because this is the one leg of the escrow
 * that had never run against a real balance, and *the pilot pays one cent* was
 * decided precisely so that it would. What the ledger records is the booking;
 * what this records is that the sweep was the thing that made it, and when.
 *
 * A quest that failed to refund is an `error` line and not a silent count. It is
 * either a lost race — harmless, and the next tick finds an empty escrow — or a
 * quest whose money cannot come back, which is the one thing here worth waking
 * somebody for.
 */
export function refundSweep(sweep: () => Promise<RefundOutcome>): SweepSpec<RefundOutcome> {
  return {
    name: 'quest-refunds',
    sweep,
    empty: { refunded: [], failed: [] },
    report: (outcome) =>
      outcome.refunded.length === 0 && outcome.failed.length === 0
        ? undefined
        : {
            message: `quest refunds: ${outcome.refunded.length} refunded, ${outcome.failed.length} failed`,
            fields: {
              event: 'quest.refunds.swept',
              refunded: outcome.refunded,
              credits: outcome.refunded.reduce((total, one) => total + one.credits, 0),
              ...(outcome.failed.length > 0 && {
                failed: outcome.failed.map((one) => ({
                  taskId: one.taskId,
                  error: one.error instanceof Error ? one.error.message : String(one.error),
                })),
              }),
            },
          },
  }
}
