import { asc } from 'drizzle-orm'
import type { AtlasCategoryRow, AtlasCategoryBranch } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { atlasCategories } from '../schema/atlas-categories.js'

type Handle = Database | Transaction

/**
 * The taxonomy, read back out of the table (`#1102`).
 *
 * **Read and not imported.** `ATLAS_SEEDED_CATEGORIES` in `core` is what the
 * migration seeded and it stops being the authority the moment it lands: a shelf
 * the Colony discovers it needs is a row somebody wrote, and a surface that
 * rendered the constant would not show it. The constant's remaining job is to be
 * what the seed was generated from and what a test compares this against.
 *
 * **Sorted by slug and not by insertion.** `added_at` would put the sixteenth
 * shelf at the bottom of whichever list it was added to, which is a rendering
 * decision nobody took; alphabetical is the one order two readers agree on
 * without being told.
 */
export async function atlasCategoryList(db: Handle): Promise<readonly AtlasCategoryRow[]> {
  const rows = await db.select().from(atlasCategories).orderBy(asc(atlasCategories.slug))

  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    standfirst: row.standfirst,
    parent: row.parentSlug,
  }))
}

/**
 * The same rows, as the two levels they are (`#1102`, decision 2).
 *
 * **Assembled here rather than in SQL**, for `atlasEntries`' reason: a recursive
 * query returning JSON would put the shape somewhere it cannot be parsed, and
 * the tree is small enough that the whole table is the cheapest read.
 *
 * A sub category whose parent is missing cannot exist — the composite foreign
 * key in `0279` is what makes that true — so nothing here has to decide what to
 * do with an orphan.
 */
export async function atlasCategoryTree(db: Handle): Promise<readonly AtlasCategoryBranch[]> {
  const rows = await atlasCategoryList(db)

  return rows
    .filter((one) => one.parent === null)
    .map((top) => ({
      ...top,
      parent: null,
      subs: rows.filter((one) => one.parent === top.slug),
    }))
}
