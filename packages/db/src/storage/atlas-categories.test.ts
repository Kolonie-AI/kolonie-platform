import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { AccountKindSchema, ATLAS_SEEDED_CATEGORIES } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { atlasCategoryList, atlasCategoryTree } from './atlas-categories.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'

/**
 * The taxonomy as rows (`#1102`).
 *
 * Two halves are worth testing and they are not the same claim. The first is
 * that the shelves *read back* — that a surface which stopped importing the enum
 * gets the same twenty things it used to compile against. The second is that the
 * shapes nobody wants are refused **by the database**, not by the code above it:
 * every rejection below is asserted as a raised constraint, because a rule that
 * only the writing path enforces is one a psql prompt walks straight through.
 */

const target = databaseTestTarget()

const kind = (value: string) => AccountKindSchema.parse(value)

const entry = async (db: Database, provider: string, category = 'code-hosting') =>
  writeProviderRecipe(db, {
    kind: kind('github'),
    provider,
    title: provider,
    status: 'joinable',
    category,
    steps: [{ actor: 'agent', instruction: 'sign up' }],
    proves: 'provider-post',
  })

describe('the Atlas taxonomy', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('holds every shelf the constant was generated from', async () => {
    const rows = await atlasCategoryList(db)

    expect([...rows].map((one) => one.slug).sort()).toEqual(
      [...ATLAS_SEEDED_CATEGORIES].map((one) => one.slug).sort(),
    )
    /** The titles too: a row and a heading that disagreed would be one fact twice. */
    expect([...rows].sort((a, b) => a.slug.localeCompare(b.slug))).toEqual(
      [...ATLAS_SEEDED_CATEGORIES].sort((a, b) => a.slug.localeCompare(b.slug)),
    )
  })

  /**
   * The read a reader meets the taxonomy through. Asserted against the constant
   * rather than against five hard-coded names, so adding a sixth top category is
   * a row and a seed line rather than a row, a seed line and an edit here.
   */
  it('assembles the tree with every sub category under its parent', async () => {
    const tree = await atlasCategoryTree(db)

    const tops = ATLAS_SEEDED_CATEGORIES.filter((one) => one.parent === null)
    expect(tree.map((one) => one.slug).sort()).toEqual(tops.map((one) => one.slug).sort())

    const placed = tree.flatMap((top) => top.subs.map((sub) => sub.slug)).sort()
    expect(placed).toEqual(
      ATLAS_SEEDED_CATEGORIES.filter((one) => one.parent !== null)
        .map((one) => one.slug)
        .sort(),
    )
    for (const top of tree) {
      for (const sub of top.subs) expect(sub.parent).toBe(top.slug)
    }
  })

  /**
   * **The trigger, seen from above.** An entry names one category in its own
   * column and the join table is filled for it — which is what lets a later
   * issue give an entry a second shelf without every writer learning about a
   * second table first.
   */
  it('files a written entry on the shelf its column names', async () => {
    await entry(db, 'github.com')

    const written = await providerRecipe(db, kind('github'), 'github.com')

    expect(written?.category).toBe('code-hosting')
    expect(written?.categories).toEqual(['code-hosting'])
  })

  it('moves the primary shelf when the entry changes category', async () => {
    await entry(db, 'github.com')
    await entry(db, 'github.com', 'project-tracking')

    const written = await providerRecipe(db, kind('github'), 'github.com')

    expect(written?.categories).toEqual(['project-tracking'])
  })

  describe('what the database itself refuses', () => {
    it('refuses a third level', async () => {
      await expectRejection(
        () =>
          db.execute(sql`
            insert into "atlas_categories" ("slug", "title", "standfirst", "parent_slug")
            values ('too-deep', 'Too deep', 'A shelf under a shelf.', 'code-hosting')
          `),
        /atlas_categories_parent_is_top/,
      )
    })

    it('refuses an entry filed under a shelf that does not exist', async () => {
      await expectRejection(
        () => entry(db, 'nowhere.example', 'not-a-shelf'),
        /provider_recipes_category_atlas_categories_slug_fk/,
      )
    })

    it('refuses a second primary shelf on one entry', async () => {
      await entry(db, 'github.com')

      await expectRejection(
        () =>
          db.execute(sql`
            insert into "provider_recipe_categories" ("recipe_id", "category_slug", "primary")
            select "id", 'project-tracking', true from "provider_recipes"
             where "provider" = 'github.com'
          `),
        /provider_recipe_categories_one_primary/,
      )
    })
  })
})
