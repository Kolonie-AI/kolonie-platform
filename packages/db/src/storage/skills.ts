import { asc, eq, sql } from 'drizzle-orm'
import {
  SkillSchema,
  type AgentId,
  type Skill,
  type SubmissionId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentSkills } from '../schema/index.js'

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
 *
 * **Aliased, and every identifier written out** (#183). In a *select-field*
 * position — which is the only position this is ever used in — Drizzle renders
 * `${table.column}` as a bare `"skill"`, `"agent_id"`, `"id"`. Measured
 * 2026-08-01, the interpolated version compiled to:
 *
 * ```sql
 * (select array_agg("skill" order by "skill") from "agent_skills" where "agent_id" = "id")
 * ```
 *
 * That was correct, and correct by luck: `agent_skills` has a composite primary
 * key and no `id` column of its own, so `"id"` fell through to the outer
 * `agents.id`. Give that table an `id` — an ordinary thing to do — and the
 * predicate silently becomes `agent_skills.agent_id = agent_skills.id`, false
 * for every row, and **every agent in the Colony reports holding no skills**.
 * Skills are the gate (D-030), so that is the whole platform answering *you may
 * do nothing*, from a query that still returns a row and raises nothing.
 *
 * A `where` position would have been safe — Drizzle qualifies there — but this
 * is not one. The alias makes the expression mean the same thing wherever it is
 * embedded, which is the remedy `currentSessionIdSql` already uses.
 *
 * **Position is half the condition and the query's shape is the other half**
 * (`#301`, measured 2026-08-04): Drizzle omits the table name only when the
 * statement has one table in scope, so the same fragment in the same select
 * field comes out qualified as soon as anything joins. The rendering above is
 * this fragment's, in this fragment's callers, and it is not a general rule
 * about select fields — `bare-identifiers.test.ts` carries the correction and
 * the measurement.
 *
 * **The outer reference is written out too, and that is the half that matters.**
 * Aliasing the inner table alone still left `= "id"`, which resolves outward
 * only because nothing nearer declares it — the same luck in a smaller place.
 * `agents.id` says what is meant, and the doc line above is what keeps it
 * honest: this fragment requires `agents` in scope, so naming it is not an
 * assumption, it is the contract.
 *
 * The cost, stated rather than hidden: with no table object interpolated, a
 * rename of either table is no longer a compile error here. That is the same
 * trade `currentSessionIdSql` makes, and it is the right way round — a rename
 * breaks loudly at the first query, and this bug does not break at all.
 */
export const heldSkillsSql = sql<
  string[]
>`coalesce((select array_agg(held.skill order by held.skill) from agent_skills held where held.agent_id = agents.id), '{}'::text[])`

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
