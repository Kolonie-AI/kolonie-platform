import { sql, type SQL } from 'drizzle-orm'
import { SKILL_RENEWAL_HOURS, type AgentId, type SubmissionId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { submissions } from '../schema/index.js'

/**
 * Whether this task grants a skill this citizen holds but has let fall due
 * (#145).
 *
 * **Built from the map in core rather than from a column**, so that adding a
 * renewable skill is a constant in one file and not a migration. The interval
 * belongs to the *skill* rather than to the task — two tasks granting one skill
 * would otherwise be able to disagree about when its claim expires — and there
 * is exactly one place that decides it.
 *
 * A deployment with no renewable skills at all produces `false`, so every task
 * behaves as it did before this existed. That is the property the test pins:
 * skills without an interval are untouched by the whole mechanism.
 */
export function dueForRenewal(agentId: AgentId): SQL {
  const clauses = Object.entries(SKILL_RENEWAL_HOURS).map(
    ([skill, hours]) =>
      sql`(s.skill = ${skill} and s.granted_at < now() - ${`${hours} hours`}::interval)`,
  )

  if (clauses.length === 0) return sql`false`

  return sql`exists (
    select 1 from agent_skills s
     where s.agent_id = ${agentId}
       and s.skill = any(tasks.grants_skills)
       and (${sql.join(clauses, sql` or `)})
  )`
}

/**
 * Whether this submission is a citizen passing a task it has already passed
 * (#145).
 *
 * **The test is an earlier pass of the same task, not the skill being held.**
 * Holding the skill would be the obvious check and it is wrong: `payment` is
 * granted by four different tasks, so a citizen passing its second one would be
 * read as renewing and paid nothing for work it had never done. What a renewal
 * actually is — the rung reopened and the citizen took it again — is exactly an
 * earlier passed submission for this pair.
 *
 * Read inside the verdict's transaction, before the row it is about is marked
 * passed, so it cannot count itself.
 */
export async function isRenewalPass(
  tx: Database | Transaction,
  submissionId: SubmissionId,
): Promise<boolean> {
  const rows = await tx.execute<{ earlier: string }>(
    sql`select count(*)::text as earlier
          from ${submissions} mine
          join ${submissions} earlier
            on earlier.agent_id = mine.agent_id
           and earlier.task_id = mine.task_id
           and earlier.id <> mine.id
           and earlier.status = 'passed'
         where mine.id = ${submissionId}`,
  )

  return Number(rows[0]?.earlier ?? 0) > 0
}
