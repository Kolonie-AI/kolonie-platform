import { inArray, sql } from 'drizzle-orm'
import { taskReports } from '../schema/index.js'
import type { Transaction } from '../client.js'

/**
 * Rebuild the cached counts in the guidance subsystem from the rows they cache
 * (#106).
 *
 * ## What actually drifts, which is less than it looks
 *
 * Both counts are caches, and both are maintained correctly by every path that
 * *writes* a report:
 *
 * - `helpful_count` and `unhelpful_count` are **recomputed** from
 *   `report_feedback` on every vote — `voteReport` runs a `count(*)` subquery
 *   rather than incrementing — so a vote can never leave them wrong.
 * - `confirmations` is set to 1 on approval and incremented on a merge. It looks
 *   like the fragile one, and it is not: a merged entry can never be
 *   re-moderated (`recordModeration` writes only over `pending`) and never
 *   revised (`mayRevise` refuses `merged` outright), so **there is no path that
 *   reverses a merge**. The increment cannot be left dangling by moderation.
 *
 * **The one thing that breaks them is a deletion neither path knows about**, and
 * exactly one exists: a citizen erasing itself (#91). Its merged reports cascade
 * away and the canonical entry they were counted in keeps counting them; its
 * votes on other citizens' reports cascade away and those reports keep counting
 * them. Both leave a number that no longer matches the rows underneath it, and
 * both are somebody *else's* row — which is why the Colony fixes its own cache
 * rather than refusing the erasure.
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
    /** Canonical reports that had a duplicate merged into them. */
    readonly confirmedIds: readonly string[]
    /** Reports that had a vote cast on them. */
    readonly votedIds: readonly string[]
  },
): Promise<void> {
  if (affected.confirmedIds.length > 0) {
    /**
     * **A count of distinct agents, not of merged rows** — and that changed with
     * #110.
     *
     * It used to be `1 + count(*)` over the duplicates, which was exact while
     * one agent could hold at most one report per task. One report per *attempt*
     * makes several merged rows from the same agent possible, and counting rows
     * would then repair a drifted number into a differently wrong one that
     * measures persistence.
     *
     * The `1 +` is still the author: `confirmations` counts agents **including**
     * the one that wrote the canonical entry, and deriving it from the merged
     * rows alone would leave every canonical entry reading one report short. The
     * author is excluded from the subquery for the same reason it is added back
     * — an author that also merged a later report into its own entry must not be
     * counted twice.
     */
    await tx
      .update(taskReports)
      .set({
        confirmations: sql`1 + (
          select count(distinct merged_attempt.agent_id)::int
            from task_reports merged
            join task_attempts merged_attempt on merged_attempt.id = merged.attempt_id
           where merged.duplicate_of = ${taskReports.id}
             and merged_attempt.agent_id <> (
               select agent_id from task_attempts where id = ${taskReports.attemptId}
             )
        )`,
      })
      .where(inArray(taskReports.id, [...affected.confirmedIds]))
  }

  if (affected.votedIds.length > 0) {
    // The same two subqueries `voteReport` writes, so the counters land in
    // exactly the state an ordinary vote would have left them in. Restated
    // rather than shared, because sharing them would mean the vote path calling
    // through a function whose whole purpose is repair.
    await tx
      .update(taskReports)
      .set({
        helpfulCount: sql`(
          select count(*)::int from report_feedback
           where report_feedback.report_id = ${taskReports.id} and report_feedback.helpful = true
        )`,
        unhelpfulCount: sql`(
          select count(*)::int from report_feedback
           where report_feedback.report_id = ${taskReports.id} and report_feedback.helpful = false
        )`,
      })
      .where(inArray(taskReports.id, [...affected.votedIds]))
  }
}
