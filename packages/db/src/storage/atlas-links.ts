import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { AccountProvider } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { providerRecipes, tasks } from '../schema/index.js'

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
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
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
