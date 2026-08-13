import { eq, sql } from 'drizzle-orm'
import type { AcademyProgress, AgentId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents } from '../schema/agents.js'
import { agentSkills } from '../schema/agent-skills.js'
import { submissions } from '../schema/submissions.js'
import { taskAttempts } from '../schema/attempts.js'
import { toTimestamp } from './rows.js'

/**
 * Where a citizen stands, in the four facts a diagnosis needs (`#836`, `#837`).
 *
 * **Four facts and not the Academy's own model, deliberately.** A doctor rule
 * needs to know whether the record *moved*, not what it says — and handing the
 * rules the full academy state would let one branch on which skill somebody
 * holds, which is a judgement about a citizen's worth rather than a shape in the
 * numbers.
 *
 * **`lastProgressAt` is the maximum over four kinds of movement**: a submission,
 * an attempt opened or closed, a skill granted, and the citizen's own record
 * being touched. Widening this set is the right fix if `no-progress` ever fires
 * on somebody who was in fact getting somewhere — the threshold is not what
 * would be wrong in that case, the definition of *moved* is. That sentence is
 * here rather than in the rule because this is where the definition lives.
 *
 * **One statement, three left joins and aggregates — deliberately not four
 * correlated subqueries**, which is how this was written first and is a defect
 * this repository has already paid for twice. `bare-identifiers.test.ts` (`#183`)
 * records it: a subquery in a *select field* of a *single-table* statement has
 * its columns rendered **bare**, so `${'${agentSkills.agentId}'} = ${'${agents.id}'}` compiles to
 * `"agent_id" = "id"` and both resolve against the inner table — a predicate
 * that is false for every row, and a count that comes back a confident zero with
 * nothing erroring and nothing warning.
 *
 * Joining fixes it at the root rather than by measurement: Drizzle omits a table
 * name only when exactly one table is in scope, so every identifier in a joined
 * statement is qualified. The fan-out three joins produce does not reach any
 * figure here — `max` and `min` are indifferent to duplicate rows, and the one
 * count is `distinct`.
 *
 * It is called once per citizen per pass by the runner (`#839`) and once per
 * request by `kolonie.doctor`, so four round trips would be four times the cost
 * for one value.
 */
export async function academyProgressFor(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<AcademyProgress | null> {
  const [row] = await db
    .select({
      registeredAt: agents.createdAt,
      skillsHeld: sql<number>`count(distinct ${agentSkills.skill})::int`,
      /**
       * **`eq()` rather than a literal in the template, and that is the fix for
       * `#870` rather than the spelling** (`#870`).
       *
       * This read `= 'accepted'` from `#836` until 2026-08-13. There is no
       * `accepted` in `submission_status` — it is `pending | verifying | passed |
       * failed` — so PostgreSQL refused the whole statement with `22P02`,
       * *invalid input value for enum submission_status*, and **every**
       * `kolonie.doctor` call and every doctor pass threw. Not a wrong number: no
       * answer at all, for every citizen, from the day it shipped.
       *
       * A literal inside a `sql` template is a string to TypeScript and a value
       * to PostgreSQL, and nothing in between checks that they agree. `eq()`
       * takes the column's own union, so `'accepted'` here does not compile —
       * which is the difference between a defect this suite could catch and one
       * only production could.
       */
      firstPassAt: sql<
        string | null
      >`min(${submissions.verifiedAt}) filter (where ${eq(submissions.status, 'passed')})`,
      lastProgressAt: sql<string | null>`greatest(
        max(${submissions.submittedAt}),
        max(${taskAttempts.openedAt}),
        max(${taskAttempts.closedAt}),
        max(${agentSkills.grantedAt}))`,
    })
    .from(agents)
    .leftJoin(agentSkills, eq(agentSkills.agentId, agents.id))
    .leftJoin(submissions, eq(submissions.agentId, agents.id))
    .leftJoin(taskAttempts, eq(taskAttempts.agentId, agents.id))
    .where(eq(agents.id, agentId))
    .groupBy(agents.id, agents.createdAt)
    .limit(1)

  // `null` for a citizen that does not exist, rather than a fabricated record.
  // The one caller that can hit this is a pass reading a citizen erased between
  // the listing and the read, and inventing a registration date for somebody who
  // is gone would put a diagnosis on a row nobody owns.
  if (row === undefined) return null

  return {
    registeredAt: toTimestamp(row.registeredAt),
    skillsHeld: row.skillsHeld,
    firstPassAt: row.firstPassAt === null ? null : toTimestamp(row.firstPassAt),
    lastProgressAt: row.lastProgressAt === null ? null : toTimestamp(row.lastProgressAt),
  }
}
