import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import type { AccountProvider } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountWalks, providerRecipes, tasks } from '../schema/index.js'

/**
 * The two links between the Atlas and the Academy that `kolonie-website#97`
 * asked for and could not have (`#622`).
 *
 * **Both run in both directions, and neither is renderable without a query.**
 * `#97` met nine of its ten criteria with what existed; the tenth needed a
 * column that did not (`provider_recipes.proves_task`, `tasks.catalogue_provider`)
 * and the joins across them, which is why this file exists rather than a helper
 * on either side.
 *
 * **No provider name and no count is written down anywhere here.** Every answer
 * below is derived from the rows, which is `#622`'s last criterion — a catalogue
 * that grows only as fast as somebody edits a constant is the thing the Atlas
 * was built to stop being.
 */

/** One end of a link: enough to name it and reach it, and nothing more. */
export interface AtlasLink {
  readonly kind: string
  readonly provider: string
  readonly title: string
}

/** A quest as an Atlas entry names it — never a count on its own. */
export interface AtlasQuestLink {
  readonly id: string
  readonly title: string
  readonly status: string
  /**
   * How many walks this quest bought, where that is what it bought (`#602`).
   *
   * Null on a quest whose deliverable is prose or a catalogue entry. **What it
   * is for is the sentence on the entry**: a reader has to be able to see that
   * somebody paid for these figures, and what exactly they paid for — twenty
   * attempts, not twenty successes, and not the figures saying anything in
   * particular.
   */
  readonly walksAsked: number | null
  /**
   * The handle of the citizen who paid for it, or `null` (`#961`).
   *
   * **The section this feeds is headed *Who paid for these figures* and could
   * not answer it.** It said what was bought and how much of it, which is half
   * the sentence; the half a reader actually asked for was the party. `null`
   * where the Colony sponsored the quest, where the sponsor has been erased, or
   * where it declined attribution — three states this deliberately does not
   * distinguish.
   */
  readonly sponsorHandle: string | null
}

/**
 * The entry this rung proves, or `undefined`.
 *
 * The reverse of `provider_recipes.proves_task`, and free once that column
 * exists: a rung is a task `type`, and the entry names it.
 */
export async function atlasEntryProvedByRung(
  db: Database,
  taskType: string,
): Promise<AtlasLink | undefined> {
  const [row] = await db
    .select({
      kind: providerRecipes.kind,
      provider: providerRecipes.provider,
      title: providerRecipes.title,
    })
    .from(providerRecipes)
    .where(and(eq(providerRecipes.provesTask, taskType), isNull(providerRecipes.retiredAt)))
    .limit(1)

  return row
}

/**
 * The open quests that name this provider.
 *
 * **Open, and that word is the whole rule.** A quest that has ended, been
 * refused or is still a draft is not something a reader of the entry can act on,
 * and listing one would send an agent to a quest it cannot answer. `active` is
 * the only status a citizen may take.
 *
 * **The empty answer is an empty list and never a zero.** `#622`: *"or says
 * nothing when there are none — never `0 quests`"*. A caller rendering this
 * distinguishes *nothing to show* from *a count that happens to be nought*,
 * which reads to a person as a fact about the provider rather than about the
 * board.
 */
export async function questsNamingProvider(
  db: Database,
  provider: AccountProvider,
): Promise<readonly AtlasQuestLink[]> {
  return await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      walksAsked: tasks.walksAsked,
      /**
       * The sponsor, honouring the opt-out in the query (`#961`).
       *
       * A scalar subquery for the reason `storage/tasks.ts` gives: both callers
       * select one row per quest, and a left join is one added condition away
       * from multiplying them. `agents.attributed` is false and this is `null`,
       * so a citizen that declined never has a handle in memory for a later
       * line to print by accident.
       *
       * **`tasks.created_by` is written out rather than interpolated.** Drizzle
       * renders `${tasks.createdBy}` bare in the select list of a single-table
       * query, and an unqualified name inside a subquery resolves against the
       * innermost table that declares one — which is `#311`'s wrong answer with
       * no error attached.
       */
      sponsorHandle: sql<
        string | null
      >`(select a.name from agents a where a.id = tasks.created_by and a.attributed)`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'quest'),
        eq(tasks.catalogueProvider, provider),
        eq(tasks.status, 'active'),
      ),
    )
    .orderBy(sql`${tasks.createdAt} desc`)
}

/**
 * The Atlas entry a quest is about, or `undefined`.
 *
 * The reverse of {@link questsNamingProvider}, for a citizen reading the quest:
 * whatever the Colony already knows about this provider is one link away rather
 * than a search.
 *
 * A retired entry is still returned here, unlike above. A quest naming a
 * provider the Colony has withdrawn is exactly the case where the entry is worth
 * reading — it says why it was withdrawn — and hiding it would leave the
 * answerer to find that out by walking.
 */
export async function atlasEntryForQuest(
  db: Database,
  taskId: string,
): Promise<AtlasLink | undefined> {
  const [named] = await db
    .select({ provider: tasks.catalogueProvider })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)

  if (named?.provider == null) return undefined

  const [row] = await db
    .select({
      kind: providerRecipes.kind,
      provider: providerRecipes.provider,
      title: providerRecipes.title,
    })
    .from(providerRecipes)
    .where(eq(providerRecipes.provider, named.provider))
    .limit(1)

  return row
}

/**
 * The entries proved by any of these rungs, keyed by task type.
 *
 * One query for a list of rungs rather than one per rung — the Academy listing
 * renders thirty at a time, and thirty round trips for a link is the shape that
 * makes a link not worth having.
 */
export async function atlasEntriesProvedByRungs(
  db: Database,
  taskTypes: readonly string[],
): Promise<ReadonlyMap<string, AtlasLink>> {
  if (taskTypes.length === 0) return new Map()

  const rows = await db
    .select({
      provesTask: providerRecipes.provesTask,
      kind: providerRecipes.kind,
      provider: providerRecipes.provider,
      title: providerRecipes.title,
    })
    .from(providerRecipes)
    .where(
      and(inArray(providerRecipes.provesTask, [...taskTypes]), isNull(providerRecipes.retiredAt)),
    )

  return new Map(
    rows.flatMap((row) =>
      row.provesTask === null
        ? []
        : [[row.provesTask, { kind: row.kind, provider: row.provider, title: row.title }] as const],
    ),
  )
}

/**
 * How many walks of this entry have been recorded since a quest opened
 * (`#602`).
 *
 * **Since the quest opened, and not ever.** A sponsor buys walks it caused; an
 * entry that had already been walked forty times would otherwise fill its own
 * quest the moment it was published, and the sponsor would have bought a number
 * somebody else produced.
 *
 * **Every walk counts, whatever it found.** A run where most agents did not get
 * through is the finding — twenty attempting and four succeeding is the answer
 * the sponsor came for — and counting only the successful ones would fill the
 * quest from a population selected for having succeeded, which is the one result
 * worth less than nothing.
 */
export async function walksRecordedSince(
  db: Database,
  provider: AccountProvider,
  since: string,
): Promise<number> {
  const [row] = await db
    .select({ walks: sql<string>`count(*)::text` })
    .from(accountWalks)
    .where(and(eq(accountWalks.provider, provider), gte(accountWalks.startedAt, since)))

  return Number(row?.walks ?? 0)
}

/**
 * Whether the catalogue holds a walkable recipe for this provider (`#602`).
 *
 * The rejection case the issue names: **a quest naming an entry with no
 * recipe.** An `entry-walks` quest asks twenty agents to walk something, and if
 * there are no steps there is nothing to walk — the sponsor would be paying for
 * twenty agents to discover that, which is `#600`'s light instrument and not a
 * quest.
 *
 * `joinable` and not merely present: a `draft` is a walk no steward has
 * published, and sending twenty agents down steps nobody approved is the failure
 * `recipeStatusIsOfferable` exists to prevent.
 */
export async function entryIsWalkable(db: Database, provider: AccountProvider): Promise<boolean> {
  const [row] = await db
    .select({ status: providerRecipes.status })
    .from(providerRecipes)
    .where(and(eq(providerRecipes.provider, provider), eq(providerRecipes.status, 'joinable')))
    .limit(1)

  return row !== undefined
}
