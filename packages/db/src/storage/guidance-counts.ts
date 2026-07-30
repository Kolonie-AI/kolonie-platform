import { inArray, sql } from 'drizzle-orm'
import { taskStruggles, taskTips } from '../schema/index.js'
import type { Transaction } from '../client.js'

/**
 * Rebuild the two cached counts in the guidance subsystem from the rows they
 * cache (#106).
 *
 * ## What actually drifts, which is less than it looks
 *
 * Both counts are caches, and both are maintained correctly by every path that
 * *writes* guidance:
 *
 * - `task_tips.helpful_count` and `unhelpful_count` are **recomputed** from
 *   `tip_feedback` on every vote — `recordTipFeedback` runs a `count(*)`
 *   subquery rather than incrementing — so a vote can never leave them wrong.
 * - `task_struggles.confirmations` is set to 1 on approval and incremented on a
 *   merge. It looks like the fragile one, and it is not: a merged entry can
 *   never be re-moderated (`moderateEntry` writes only over `pending`) and never
 *   revised (`mayRevise` refuses `merged` outright), so **there is no path that
 *   reverses a merge**. The increment cannot be left dangling by moderation.
 *
 * **The one thing that breaks them is a deletion neither path knows about**, and
 * exactly one exists: a citizen erasing itself (#91). Its merged struggles
 * cascade away and the canonical entry they were counted in keeps counting them;
 * its votes on other citizens' tips cascade away and those tips keep counting
 * them. Both leave a number that no longer matches the rows underneath it, and
 * both are somebody *else's* row — which is why the Colony fixes its own cache
 * rather than refusing the erasure.
 *
 * This is narrower than `#106` was written to be, and the issue was corrected
 * rather than the code stretched to meet it. A recompute wired into paths that
 * are already correct would be work that can only ever confirm what is already
 * true, and it would make the real caller — erasure — look like one case among
 * several instead of the only one.
 *
 * ## Why ids and not a task
 *
 * The caller knows precisely which rows it disturbed, and a task-wide recompute
 * would rewrite rows nothing touched. That matters beyond tidiness: this runs
 * inside the erasing transaction, which already holds a lock on the agent, and
 * widening it to every entry on a busy task is how an erasure starts contending
 * with the moderation runner.
 *
 * Both lists are empty for almost every erasure, and that is the ordinary path
 * rather than a special case: the function returns immediately.
 */
export async function rebuildGuidanceCounts(
  tx: Transaction,
  affected: {
    /** Canonical struggles that had a duplicate merged into them. */
    readonly struggleIds: readonly string[]
    /** Tips that had a vote cast on them. */
    readonly tipIds: readonly string[]
  },
): Promise<void> {
  if (affected.struggleIds.length > 0) {
    /**
     * `1 +` the duplicates, because `confirmations` counts **agents including
     * the author** — approval sets it to 1 and each merge adds one. Deriving it
     * as a count of merged rows alone would silently drop the author and make
     * every canonical entry read one report short.
     */
    await tx
      .update(taskStruggles)
      .set({
        confirmations: sql`1 + (
          select count(*)::int from ${taskStruggles} as merged
           where merged.duplicate_of = ${taskStruggles.id}
        )`,
      })
      .where(inArray(taskStruggles.id, [...affected.struggleIds]))
  }

  if (affected.tipIds.length > 0) {
    // The same two subqueries `recordTipFeedback` writes, so the counters land
    // in exactly the state an ordinary vote would have left them in. Restated
    // rather than shared, because sharing them would mean the vote path calling
    // through a function whose whole purpose is repair.
    await tx
      .update(taskTips)
      .set({
        helpfulCount: sql`(
          select count(*)::int from tip_feedback
           where tip_feedback.tip_id = ${taskTips.id} and tip_feedback.helpful = true
        )`,
        unhelpfulCount: sql`(
          select count(*)::int from tip_feedback
           where tip_feedback.tip_id = ${taskTips.id} and tip_feedback.helpful = false
        )`,
      })
      .where(inArray(taskTips.id, [...affected.tipIds]))
  }
}
