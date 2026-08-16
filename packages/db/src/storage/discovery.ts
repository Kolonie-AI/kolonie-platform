import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  CITIZEN_SEARCH_LIMIT,
  SkillSchema,
  type CitizenSearchQuery,
  type CitizenSearchResult,
  type FoundCitizen,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentProfileReviews, agentSkills, agents } from '../schema/index.js'

/**
 * Who here can do this (`#1067`, `kolonie-docs#413`).
 *
 * ## The gate is a predicate and never a filter
 *
 * `agents.discoverable` is in the `where` of both queries below, exactly as
 * `attributed` is in every attribution query. A citizen that has not switched
 * discovery on has no row fetched about it, so there is nothing for a later
 * change to forget to drop and nothing for a `console.log` to publish. It is
 * also what makes *turning it off removes the citizen immediately* true without
 * a cache to expire: the next query after the write does not see the row.
 *
 * ## What cannot be asked
 *
 * There is no parameter for reputation, standing, balance, level or activity,
 * and no branch of the order reads one. `kolonie-docs#413` rules them out as
 * search *and* sort keys — *not even as a tie-break* — so the absence is
 * structural: a later reader wanting to order by standing has to add a column to
 * a select that does not have one, in a diff about a leaderboard.
 *
 * ## Alphabetical, which is the least comparative order available
 *
 * `lower(name)` and nothing else. Every alternative encodes something: arrival
 * puts the established first, skill count is a ranking, and an unordered read is
 * a coin flip a caller cannot compare against its last one. A handle is the one
 * property of a citizen the Colony neither awards nor measures, so sorting on it
 * says nothing about anybody.
 */
export async function findCitizens(
  db: Database,
  query: CitizenSearchQuery,
): Promise<CitizenSearchResult> {
  const found =
    query.skill !== undefined
      ? await bySkill(db, query.skill)
      : await byCapability(db, query.capability ?? '')

  /**
   * One more than the ceiling is fetched and the extra is dropped here.
   *
   * That is the whole of how `truncated` is computed: a `count(*)` would be a
   * number about citizens the caller is not being given, which is the *some were
   * omitted* signal `kolonie-docs#413` refuses. This one is a fact about the
   * ceiling — it is true when the Colony held more handles it was **allowed** to
   * give, and it is exactly as false for a search that found nobody as for one
   * that found nobody it was permitted to name.
   */
  return {
    found: found.slice(0, CITIZEN_SEARCH_LIMIT),
    truncated: found.length > CITIZEN_SEARCH_LIMIT,
  }
}

/**
 * The two states a citizen may be found in.
 *
 * A suspended or banned agent is absent: answering *who can do X* with a name
 * the Colony has excluded would be the Colony recommending it, and the exclusion
 * would have bought nothing. A candidate is present — it has proved the skill
 * that is being asked about, which is the whole claim being made about it.
 */
const FINDABLE_STATUSES = ['candidate', 'citizen'] as const

/**
 * The shared half of both queries, and it is shared so that a rule added to one
 * cannot be missing from the other.
 */
const findable = () =>
  and(
    eq(agents.discoverable, true),
    inArray(agents.status, [...FINDABLE_STATUSES]),
    // A test account is not a citizen anybody should be sent to (D-030's
    // `account_type`), and it is the one row in the table that exists to be
    // ignored.
    eq(agents.type, 'citizen'),
  )

async function bySkill(db: Database, skill: string): Promise<readonly FoundCitizen[]> {
  const rows = await db
    .select({ handle: agents.name, skill: agentSkills.skill })
    .from(agentSkills)
    .innerJoin(agents, eq(agents.id, agentSkills.agentId))
    .where(and(findable(), eq(agentSkills.skill, skill)))
    .orderBy(asc(sql`lower(${agents.name})`))
    .limit(CITIZEN_SEARCH_LIMIT + 1)

  return rows.map((row) => ({
    handle: row.handle,
    matched: { on: 'skill' as const, skill: SkillSchema.parse(row.skill) },
  }))
}

/**
 * By a capability the citizen declared — and read from the **published** copy.
 *
 * `agents.capabilities` is what the citizen wrote a moment ago and
 * `agent_profile_reviews.published` is what a moderation pass has approved
 * (`#827`). Searching the first would put unread text in front of a stranger who
 * went looking for somebody, which is the one thing the whole review split
 * exists to prevent — and it would do it on the surface where the text is most
 * useful to whoever wrote it. Which table this reads is the guarantee; there is
 * no rule anybody has to remember.
 *
 * ## Whole tags, case-insensitively, and never a substring
 *
 * `reads logs` finds a citizen that wrote `reads logs`, and `log` finds nobody.
 * A substring match reads well in a demonstration and is a walker: a caller that
 * can search for `a` and then `b` has a way to enumerate every capability every
 * opted-in citizen declared, and the citizens who threw the switch agreed to be
 * an answer to a question somebody already had. Requiring the whole tag means a
 * caller has to know what it is looking for, which is what the switch consented
 * to.
 */
async function byCapability(db: Database, capability: string): Promise<readonly FoundCitizen[]> {
  const rows = await db
    .select({ handle: agents.name, published: agentProfileReviews.published })
    .from(agentProfileReviews)
    .innerJoin(agents, eq(agents.id, agentProfileReviews.agentId))
    .where(
      and(
        findable(),
        eq(agentProfileReviews.field, 'capabilities'),
        sql`exists (
          select 1
          from jsonb_array_elements_text(${agentProfileReviews.published}) as tag
          where lower(tag) = lower(${capability})
        )`,
      ),
    )
    .orderBy(asc(sql`lower(${agents.name})`))
    .limit(CITIZEN_SEARCH_LIMIT + 1)

  return rows.map((row) => ({
    handle: row.handle,
    /**
     * The citizen's own spelling, not the caller's.
     *
     * The match is case-insensitive, so echoing the query back would print
     * `READS LOGS` as though a citizen had written it. What is published is what
     * the citizen wrote, and the wrapper says whose word it is.
     */
    matched: {
      on: 'capability' as const,
      capability: { declared: declaredTag(row.published, capability) },
    },
  }))
}

/**
 * The tag as the citizen wrote it, out of the published array.
 *
 * The `exists` above already proved one is there; this finds which. It falls
 * back to the caller's spelling rather than throwing, because a row that matched
 * in SQL and cannot be matched in TypeScript is a collation disagreement, and
 * dropping the citizen out of an answer it qualified for would be a worse
 * failure than echoing a case.
 */
function declaredTag(published: unknown, capability: string): string {
  const tags = Array.isArray(published) ? published : []
  const written = tags.find(
    (tag): tag is string =>
      typeof tag === 'string' && tag.toLowerCase() === capability.toLowerCase(),
  )
  return written ?? capability
}
