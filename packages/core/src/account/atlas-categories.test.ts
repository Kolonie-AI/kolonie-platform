import { describe, expect, it } from 'vitest'
import { ATLAS_CATEGORY_TREE, ATLAS_SEEDED_CATEGORIES } from './atlas-categories.js'
import { ATLAS_SHELF_TITLES } from './atlas.js'
import { AtlasCategorySchema } from './recipe.js'

/**
 * The taxonomy the migration seeds (`#1102`).
 *
 * What is worth pinning here is not the five names — a maintainer may add a
 * sixth without touching this file — but that the seed is *complete and
 * two-level*: every one of the fifteen has a parent, no parent has a parent, and
 * nothing was renamed on the way in. The database enforces the second of those
 * on every row anybody ever inserts; these assertions catch the seed itself
 * being wrong, which is the one insert no constraint gets to refuse twice.
 */
describe('the seeded Atlas taxonomy', () => {
  const bySlug = new Map(ATLAS_SEEDED_CATEGORIES.map((one) => [one.slug, one]))

  it('shelves every category the enum knows, and invents no slug', () => {
    const subs = ATLAS_SEEDED_CATEGORIES.filter((one) => one.parent !== null).map((one) => one.slug)
    expect([...subs].sort()).toEqual([...AtlasCategorySchema.options].sort())
  })

  it('keeps the fifteen slugs and their titles exactly as the index page prints them', () => {
    for (const category of AtlasCategorySchema.options) {
      expect(bySlug.get(category)?.title).toBe(ATLAS_SHELF_TITLES[category])
    }
  })

  it('is exactly two levels: every parent is a top category', () => {
    for (const one of ATLAS_SEEDED_CATEGORIES) {
      if (one.parent === null) continue
      expect(bySlug.get(one.parent)?.parent).toBe(null)
    }
  })

  it('writes every parent before the row that hangs from it, which is what the seed needs', () => {
    const written = new Set<string>()
    for (const one of ATLAS_SEEDED_CATEGORIES) {
      if (one.parent !== null) expect(written.has(one.parent)).toBe(true)
      written.add(one.slug)
    }
  })

  it('says something about every shelf, top and sub alike', () => {
    for (const one of ATLAS_SEEDED_CATEGORIES) {
      expect(one.standfirst.length).toBeGreaterThan(20)
    }
  })

  it('reads as a tree that loses nobody', () => {
    expect(ATLAS_CATEGORY_TREE.flatMap((top) => top.subs).length).toBe(
      AtlasCategorySchema.options.length,
    )
    for (const top of ATLAS_CATEGORY_TREE) expect(top.subs.length).toBeGreaterThan(0)
  })
})
