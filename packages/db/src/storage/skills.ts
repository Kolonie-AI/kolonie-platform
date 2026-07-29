import { asc, eq, sql } from 'drizzle-orm'
import {
  SkillSchema,
  type AgentId,
  type Skill,
  type SubmissionId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, agentSkills } from '../schema/index.js'

/**
 * The skills an agent holds, as a correlated subquery over `agent_skills`.
 *
 * Every read that produces an `Agent` selects this alongside the row, so the
 * skills travel with the agent rather than being fetched by whoever remembers
 * to. They are the gate now (D-030) — a code path that forgot them would not
 * fail, it would quietly report an agent that can do nothing.
 *
 * Ordered inside the aggregate so two reads of an unchanged agent produce the
 * same array. `array_agg` has no order of its own, and an API response whose
 * field order drifts between calls is one a client cannot compare.
 *
 * Only usable in a query that has `agents` in scope — it correlates on
 * `agents.id`.
 */
export const heldSkillsSql = sql<
  string[]
>`coalesce((select array_agg(${agentSkills.skill} order by ${agentSkills.skill}) from ${agentSkills} where ${agentSkills.agentId} = ${agents.id}), '{}'::text[])`

/** Parse what the database returned into the domain's branded slugs. */
export function toSkills(raw: readonly string[]): Skill[] {
  return raw.map((value) => SkillSchema.parse(value))
}

/** The skills one agent holds, for a caller that has no agent row in hand. */
export async function skillsOfAgent(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<Skill[]> {
  const rows = await db
    .select({ skill: agentSkills.skill })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(agentSkills.skill))

  return toSkills(rows.map((row) => row.skill))
}

/** What a grant added, which is not always what it was asked to add. */
export interface GrantedSkills {
  /** The skills this call actually wrote. Empty when the agent held them all. */
  readonly granted: readonly Skill[]
}

/**
 * Record that a passed submission earned these skills.
 *
 * **Called inside the transaction that writes the verdict**, which is why it
 * takes a `Transaction` — the signature is the rule, the same one
 * `bookTaskReward` states. A submission that says `passed` while the agent holds
 * nothing new is an agent locked out of the rung it just cleared, and only one
 * commit covering both makes that state unreachable.
 *
 * **Idempotent, and the database is what makes it so.** `on conflict do nothing`
 * against the primary key on `(agent_id, skill)`: re-passing a task grants
 * nothing new, holding a skill twice is not an error, and no caller has to
 * check first. `returning` then says which rows were genuinely new, so a log
 * line can report a grant rather than an attempt.
 *
 * Nothing here is supplied by a caller from outside: the skills come from the
 * task row that was passed, exactly as the reward does.
 */
export async function grantSkills(
  tx: Transaction,
  command: {
    readonly agentId: AgentId
    readonly submissionId: SubmissionId
    readonly skills: readonly string[]
    readonly grantedAt: Timestamp
  },
): Promise<GrantedSkills> {
  if (command.skills.length === 0) return { granted: [] }

  const rows = await tx
    .insert(agentSkills)
    .values(
      command.skills.map((value) => ({
        agentId: command.agentId,
        // Parsed rather than trusted: these come from a `text[]` column, and a
        // slug that is not a skill must fail here rather than become one.
        skill: SkillSchema.parse(value),
        submissionId: command.submissionId,
        grantedAt: command.grantedAt,
      })),
    )
    .onConflictDoNothing()
    .returning({ skill: agentSkills.skill })

  return { granted: toSkills(rows.map((row) => row.skill)) }
}
