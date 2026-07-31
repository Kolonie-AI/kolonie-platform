import { sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Transaction } from '../client.js'

/**
 * What promotion had to do, so the caller can rebuild the counts afterwards.
 */
export interface PromotedEntries {
  /** Entries that became canonical in place of one the leaving citizen wrote. */
  /** Canonical reports that were promoted in a departing entry's place. */
  readonly promotedIds: readonly string[]
}

/**
 * Hand a citizen's canonical entries over to the agents that were merged into
 * them, so the citizen can leave (#107).
 *
 * ## The one place an erasure can be blocked by somebody else's row
 *
 * `task_reports.duplicate_of` is `restrict`, and
 * #90 kept them that way after ruling out both alternatives:
 *
 * - **`cascade`** would delete agent B's own writing to satisfy agent A's
 *   erasure. Erasure is a right a citizen exercises over *its own* rows, and
 *   taking a bystander's report with it is the one thing it must never do.
 * - **`set null`** is refused by `task_reports_duplicate_iff_merged`. A
 *   `merged` row with no pointer is *a report the Colony folded into nothing*,
 *   and the constraint exists precisely to make that unrepresentable. The schema
 *   comment records that this was tried and caught.
 *
 * So the pointers are resolved *before* the delete, and the constraint's job is
 * to make forgetting to do so a loud failure rather than a silent hole.
 *
 * ## Why the oldest duplicate wins
 *
 * It is **the earliest surviving independent report of the same wall**. The
 * entry that is leaving was canonical because it was first, so the rule that
 * replaces it is the same rule applied to what is left — rather than a new one
 * invented for this case. Picking the newest would make the corpus's idea of
 * "who found this first" depend on who happened to erase themselves; picking
 * whichever row the query returned first would make it depend on the planner.
 *
 * The tie-break is the id, so two reports filed in the same millisecond resolve
 * the same way on every run. That matters less for correctness than for being
 * able to reproduce a support question a year later.
 *
 * ## What is not preserved, said plainly
 *
 * The promoted entry keeps **its own text**. The Colony does not move the
 * leaving citizen's words onto somebody else's row — that would be the one form
 * of survival erasure exists to prevent, and it would put an erased agent's
 * prose in front of readers under another agent's name. What survives is the
 * *fact* that several agents hit this wall, which is the Colony's own
 * bookkeeping and names nobody. `governance/erasure.md` §2 draws exactly this
 * line.
 *
 * ## No chains
 *
 * A merge target is always an approved entry — the moderation runner picks it
 * from `approvedOn`, which reads approved rows only — so a duplicate never
 * points at another duplicate. This function does not depend on that: it
 * promotes a dependent of the departing row whatever that row's status was, and
 * the result is a canonical entry rather than a longer chain either way.
 */
export async function promoteDuplicatesOf(
  tx: Transaction,
  agentId: AgentId,
): Promise<PromotedEntries> {
  return { promotedIds: await promoteIn(tx, agentId) }
}

/**
 * The three statements that promote an heir.
 *
 * They used to be run twice, once per table, with the table name interpolated —
 * #110 removed the second table and with it the interpolation, so the
 * identifiers are now written plainly.
 */
async function promoteIn(tx: Transaction, agentId: AgentId): Promise<string[]> {
  /**
   * The departing citizen's entries that somebody else was merged into.
   *
   * Empty for almost every erasure, which is the ordinary path rather than a
   * special case — a citizen has to have written something the Colony made
   * canonical *and* have had another agent's report folded into it.
   */
  const blocking = await tx.execute<{ id: string }>(
    sql`select mine.id
          from task_reports as mine
          join task_attempts as tried on tried.id = mine.attempt_id
         where tried.agent_id = ${agentId}
           and exists (
             select 1 from task_reports as dependent where dependent.duplicate_of = mine.id
           )`,
  )

  const promoted: string[] = []

  for (const { id } of blocking) {
    const [heir] = await tx.execute<{ id: string }>(
      sql`select id from task_reports
           where duplicate_of = ${id}
           order by created_at asc, id asc
           limit 1`,
    )
    if (heir === undefined) continue

    /**
     * The heir becomes canonical. `moderated_at` is already set — it was set
     * when the entry was merged — so `task_reports_moderated_at_matches_status`
     * holds, and clearing `duplicate_of` in the same statement as the status is
     * what keeps `task_reports_duplicate_iff_merged` satisfied at every instant
     * a constraint is checked.
     */
    await tx.execute(
      sql`update task_reports set status = 'approved', duplicate_of = null where id = ${heir.id}`,
    )

    // Its siblings now point at it. The departing entry keeps no dependents, so
    // the `restrict` below has nothing to refuse.
    await tx.execute(
      sql`update task_reports set duplicate_of = ${heir.id}
           where duplicate_of = ${id} and id <> ${heir.id}`,
    )

    promoted.push(heir.id)
  }

  return promoted
}
