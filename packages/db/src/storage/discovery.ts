import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  CITIZEN_SEARCH_LIMIT,
  PLAYBOOK_CONTRIBUTION_FORMS,
  PLAYBOOK_LISTED_STATUSES,
  PlaybookSlugSchema,
  SkillSchema,
  type CitizenSearchQuery,
  type CitizenSearchResult,
  type FoundCitizen,
  type PlaybookContributionForm,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentProfileReviews,
  agentSkills,
  agents,
  playbookRuns,
  playbookStepProposals,
  playbooks,
  tasks,
} from '../schema/index.js'

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
      : query.playbook !== undefined
        ? await byPlaybook(db, query.playbook)
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
  const found_ = found.slice(0, CITIZEN_SEARCH_LIMIT)

  /**
   * **How large the room was** (`#1495`), computed without reading the query.
   *
   * One `count(*)` over the same `findable()` predicate every search passes, so
   * two different searches in the same second answer the same number and the
   * difference against `found` says nothing about anybody. That independence is
   * the whole of why this is not the count `kolonie-docs#413` refuses.
   */
  const eligible = await eligiblePopulation(db)

  /**
   * **Only where it changes what a reader should do** (`#1495`): a skill search
   * that found nobody. A typo and an unheld skill are different findings and
   * read identically without this, which is the second half of the same defect
   * `#1067` produced — nine searches answered *nobody* and every one was
   * believed.
   */
  const skillInAcademy =
    query.skill !== undefined && found_.length === 0
      ? { skillInAcademy: await academyMintsSkill(db, query.skill) }
      : {}

  return {
    found: found_,
    truncated: found.length > CITIZEN_SEARCH_LIMIT,
    eligible,
    ...skillInAcademy,
  }
}

/**
 * How many citizens any search is allowed to match (`#1495`).
 *
 * **It does not take the query, and that is the guarantee rather than a
 * saving.** A function that could see what was asked could be made to answer
 * about it, and the number would stop being a fact about the room and become one
 * about the people in it. There is no parameter here to pass one through.
 */
async function eligiblePopulation(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(agents)
    .where(findable())

  return Number(row?.count ?? 0)
}

/**
 * Whether any rung grants this skill (`#1495`).
 *
 * **Asked of the tasks table and not of `KNOWN_SKILLS`.** That constant is a
 * vocabulary the package documents; what decides whether a citizen could ever
 * hold a slug is whether the Academy has something that grants it, and those two
 * drift the moment a rung is added. Reading the table means a skill minted
 * yesterday answers correctly with no edit here.
 *
 * It reads no citizen and returns no citizen: the question is about the
 * catalogue.
 */
async function academyMintsSkill(db: Database, skill: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(sql`${tasks.grantsSkills} @> array[${skill}]::text[]`)
    .limit(1)

  return row !== undefined
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
 * Who contributed to one named playbook, and how (`#1258`).
 *
 * ## Three reads, merged, and the merge is the answer
 *
 * The three forms live on three tables that share no key.
 * `storage/public-record.ts` reads the same relation from the other end and
 * merges the same way; the two are one relation with two entry points, which is
 * why `PLAYBOOK_CONTRIBUTION_FORMS` orders the forms for both rather than each
 * choosing.
 *
 * ## Two gates, and `attributed` is the one this file did not have before
 *
 * `findable()` is unchanged: discovery is the consent to be an answer. What is
 * new is `agents.attributed`, and it belongs here because of what this answer
 * *is* — a handle printed beside a playbook somebody worked on, which is exactly
 * the act that flag governs. The other two searches carry no such gate and need
 * none: a skill and a capability are facts about the citizen rather than
 * artefacts it left behind.
 *
 * A playbook nobody may read yields nobody, and that is the same empty answer as
 * a playbook nobody has contributed to. Those being indistinguishable is
 * `kolonie-docs#413`'s criterion applied to a slug: a search must not become a
 * way to learn that an unpublished playbook exists.
 */
async function byPlaybook(db: Database, slug: string): Promise<readonly FoundCitizen[]> {
  const readable = and(
    sql`lower(${playbooks.slug}) = lower(${slug})`,
    inArray(playbooks.status, [...PLAYBOOK_LISTED_STATUSES]),
  )
  const gate = and(findable(), eq(agents.attributed, true))

  const authored = await db
    .select({ handle: agents.name, slug: playbooks.slug })
    .from(playbooks)
    .innerJoin(agents, eq(agents.id, playbooks.authorAgentId))
    .where(and(gate, readable))

  /** `playbookContributors`' definition of folded, for `public-record.ts`'s reason. */
  const folded = await db
    .selectDistinct({ handle: agents.name, slug: playbooks.slug })
    .from(playbookStepProposals)
    .innerJoin(agents, eq(agents.id, playbookStepProposals.agentId))
    .innerJoin(playbooks, eq(playbooks.id, playbookStepProposals.playbookId))
    .where(
      and(
        gate,
        readable,
        eq(playbookStepProposals.status, 'accepted'),
        sql`${playbookStepProposals.foldedAt} is not null`,
      ),
    )

  const noted = await db
    .selectDistinct({ handle: agents.name, slug: playbooks.slug })
    .from(playbookRuns)
    .innerJoin(agents, eq(agents.id, playbookRuns.agentId))
    .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
    .where(
      and(
        gate,
        readable,
        eq(playbookRuns.noteStatus, 'approved'),
        sql`${playbookRuns.notePublished} is not null`,
      ),
    )

  const forms = new Map<string, { handle: string; slug: string; forms: Set<string> }>()
  const add = (row: { handle: string; slug: string }, form: PlaybookContributionForm) => {
    const held = forms.get(row.handle)
    if (held === undefined) {
      forms.set(row.handle, { handle: row.handle, slug: row.slug, forms: new Set([form]) })
      return
    }
    held.forms.add(form)
  }

  for (const row of authored) add(row, 'author')
  for (const row of folded) add(row, 'step')
  for (const row of noted) add(row, 'note')

  return (
    [...forms.values()]
      /**
       * Alphabetical, on `findable`'s argument and with one addition of its own:
       * ordering by how much somebody contributed would rank the contributors of
       * a playbook against each other, which is the leaderboard
       * `kolonie-docs#413` refuses. **This answer carries no count for the same
       * reason** — the profile's count is about one citizen and one pipeline, and
       * a count here would sit beside another citizen's.
       */
      .sort((left, right) => left.handle.toLowerCase().localeCompare(right.handle.toLowerCase()))
      .slice(0, CITIZEN_SEARCH_LIMIT + 1)
      .map((row) => ({
        handle: row.handle,
        matched: {
          on: 'playbook' as const,
          // The slug as the playbook holds it, not as the caller typed it: the
          // match is case-insensitive, and echoing the query back would print a
          // slug that resolves to nothing.
          playbook: PlaybookSlugSchema.parse(row.slug),
          as: PLAYBOOK_CONTRIBUTION_FORMS.filter((form) => row.forms.has(form)),
        },
      }))
  )
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
