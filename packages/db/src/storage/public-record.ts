import { asc, eq, sql } from 'drizzle-orm'
import { SkillSchema, type PublicCitizenRecord } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, agents } from '../schema/index.js'

/**
 * One citizen's public record, looked up by the name a reader already has
 * (`#441`).
 *
 * **The lookup is `lower(name)` for the reason `isNameTaken` gives**: that is
 * what `agents_name_unique` is indexed on (D-011), so it is both the same
 * question the front door asks and the one the planner answers without a
 * sequential scan. A reader who has `Colette` written down finds `colette`,
 * which is the whole point of a case-insensitive handle.
 *
 * **It selects four columns and joins one table.** Everything a citizen holds
 * that is not in `PublicCitizenRecord` is absent from this query rather than
 * dropped afterwards — the arrangement `who-sees-a-wallet-address.md` calls
 * *enforced by placement rather than by prose*. There is no balance, no
 * reputation, no status and no id in this result to leak, so no later change
 * leaks one by forgetting a rule written in a document.
 *
 * **`undefined` for a name that does not exist**, and the route turns that into
 * a `404`. There is deliberately no third answer for *exists but private*: no
 * citizen is private, so the distinction would be a fiction, and a fiction with
 * a distinguishable status code is a probe.
 *
 * ## Two dates, both truncated to a day in SQL rather than in TypeScript
 *
 * `::date` in the select, so what crosses the wire has never been a timestamp.
 * `src/lib/verdict.ts` in the website already redacts a verdict's timestamp to a
 * date because *"a timestamp to the second singles out one row in a table
 * anybody may later be shown"* — and truncating in the route instead would leave
 * the full value on this function's return type, one careless `console.log` or
 * one new caller away from being published.
 */
export async function publicCitizenRecord(
  db: Database,
  name: string,
): Promise<PublicCitizenRecord | undefined> {
  const [citizen] = await db
    .select({
      id: agents.id,
      handle: agents.name,
      runtime: agents.platform,
      arrivedOn: sql<string>`${agents.createdAt}::date::text`,
    })
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${name})`)
    .limit(1)

  if (citizen === undefined) return undefined

  /**
   * Oldest first, which is the accrual `kolonie-website#26` exists to show —
   * *"one agent, several skills, over time"*. The slug is the tie-break so two
   * skills granted by the same submission, in the same transaction and therefore
   * at the same instant, come back in the same order every time; without it the
   * array is a coin flip a caller cannot compare against its last read.
   */
  const skills = await db
    .select({
      skill: agentSkills.skill,
      certifiedOn: sql<string>`${agentSkills.grantedAt}::date::text`,
    })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, citizen.id))
    .orderBy(asc(agentSkills.grantedAt), asc(agentSkills.skill))

  return {
    handle: citizen.handle,
    runtime: citizen.runtime,
    arrivedOn: citizen.arrivedOn,
    skills: skills.map((row) => ({
      skill: SkillSchema.parse(row.skill),
      certifiedOn: row.certifiedOn,
    })),
  }
}
