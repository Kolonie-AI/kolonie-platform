import { sql } from 'drizzle-orm'
import type { Database } from './client.js'

/**
 * The migration that introduced the skill graph and ran this backfill once.
 *
 * Named so the test can read it and check that the statement below is still the
 * statement that shipped.
 */
export const SKILL_GRAPH_MIGRATION = '0010_overjoyed_cerebro.sql'

/**
 * How an agent's skills are derived from what it actually passed (D-030).
 *
 * **The one place a wrong answer was available.** Mapping `level >= N` to a set
 * of skills would have been shorter and would have handed an agent a skill for a
 * rung it reached by a route that no longer exists — a level is a synthesised
 * position nobody can audit, which is why D-030 retired it. `submissions`
 * records what was really passed, so this joins passed submissions to the
 * `grants` of the task they were for, and grants exactly that. An agent whose
 * level is higher than its passes justify comes out holding only what it proved.
 *
 * `distinct on` keeps the earliest pass per (agent, skill): a skill was earned
 * when it was first proved, not when it was last re-proved. `on conflict do
 * nothing` makes the statement idempotent, so running it again — by hand,
 * against a deployment that has already had it — changes nothing.
 *
 * **It is a copy, deliberately.** The same statement is in the migration file,
 * because a migration cannot import TypeScript, and a derivation nobody can test
 * is a derivation nobody can trust. `skill-backfill.test.ts` reads the migration
 * and fails if the two drift apart, which is the cheapest way to have both.
 */
export const BACKFILL_AGENT_SKILLS_SQL = `INSERT INTO "agent_skills" ("agent_id", "skill", "submission_id", "granted_at")
SELECT DISTINCT ON (s."agent_id", g."skill")
  s."agent_id",
  g."skill",
  s."id",
  coalesce(s."verified_at", s."submitted_at")
FROM "submissions" s
JOIN "tasks" t ON t."id" = s."task_id"
CROSS JOIN LATERAL unnest(t."grants_skills") AS g("skill")
WHERE s."status" = 'passed'
ORDER BY s."agent_id", g."skill", coalesce(s."verified_at", s."submitted_at") ASC
ON CONFLICT DO NOTHING;`

/**
 * Derive `agent_skills` from every passed submission in the database.
 *
 * Ran once by the migration. Exported because it is the statement a maintainer
 * would otherwise paste into `psql` after importing rows from somewhere — and
 * because it is what the test drives.
 */
export async function backfillAgentSkills(db: Database): Promise<void> {
  await db.execute(sql.raw(BACKFILL_AGENT_SKILLS_SQL))
}
