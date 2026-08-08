import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { AccountProviderSchema } from './account.js'
import { AtlasFiguresSchema, atlasRank, noFigures, type AtlasFigures } from './atlas-figures.js'
import { ProviderRecipeSchema, type ProviderRecipe } from './recipe.js'

/**
 * The Atlas: the provider catalogue, as something a stranger can read (`#546`).
 *
 * **The catalogue and the Atlas are one thing under two names, and that is
 * deliberate rather than sloppy.** `provider_recipes` is what the Colony stores
 * and `kolonie.accounts.providers` is what an agent calls; *Atlas* is the name
 * used with people — on the website, in a conversation with a provider. `#550`
 * refuses a second tool namespace for exactly this reason, and this module is
 * where the two names meet: one shape, assembled once, served to a browser
 * (`#547`), to an agent (`#550`) and as data (`#551`).
 *
 * ## Why the entry is not the row
 *
 * `provider_recipes` is unique on **(kind, provider)** — one row per thing you
 * can hold at a provider. A page per row would be `#547`'s doorway pattern
 * arriving from the database side: *github/account* and *github/website* are not
 * two subjects a reader is looking for, they are one provider with two things it
 * offers. So an **entry is a provider**, and its rows are what it carries.
 */

/** Where the Atlas answers, on the website's own host. */
export const ATLAS_PATH = '/atlas'

/**
 * How long a public Atlas response may be served from a cache.
 *
 * **Five minutes, and the number is chosen against the curation session rather
 * than against the traffic.** `#546` rejected a build-time Atlas because
 * curating twenty entries would mean twenty deploys; a cache measured in hours
 * would give that back — an editor fixing a wrong step would not see it and
 * would fix it again. Five minutes is short enough that a correction feels
 * applied and long enough that a crawler walking four hundred pages costs the
 * database almost nothing.
 */
export const ATLAS_CACHE_SECONDS = 300

/**
 * The path one provider's page is at.
 *
 * **The provider *is* the slug**, which is why there is no slug column anywhere.
 * `AccountProviderSchema` already normalises to one lowercase token whose
 * characters are all URL-safe, so deriving the path is a formatting concern and
 * not a stored fact — and a stored slug is a second copy of the provider's name
 * that can disagree with it.
 */
export function atlasPath(provider: string): string {
  return `${ATLAS_PATH}/${AccountProviderSchema.parse(provider)}`
}

/**
 * One Atlas entry: a provider, and everything the Colony knows about joining it.
 *
 * Assembled from rows rather than stored, so nothing can be true on the page and
 * false in the tool.
 */
export const AtlasEntrySchema = z.object({
  provider: AccountProviderSchema,
  /** The path this entry is served at, so no consumer has to build it. */
  path: z.string(),
  /**
   * What the entry is called, taken from the row a reader is most likely to want.
   *
   * A joinable row's title wins over a refusal's: a provider with one working
   * recipe and one refused kind is a provider you can join, and titling the page
   * with the refusal would say the opposite before the reader gets to the list.
   */
  title: z.string().min(1),
  /**
   * Whether **anything** here can currently be joined honestly.
   *
   * False means every row is a refusal — which is a page and not an omission
   * (`#482`), and `#547` requires it to be a full one.
   */
  joinable: z.boolean(),
  /**
   * One row per kind, in the catalogue's own order, each with what was measured
   * about it (`#545`). Never empty.
   */
  recipes: z.array(ProviderRecipeSchema.extend({ figures: AtlasFiguresSchema })).min(1),
  /** The most recent edit across the rows, which is what a reader wants dated. */
  updatedAt: TimestampSchema,
})
export type AtlasEntry = z.infer<typeof AtlasEntrySchema>

/**
 * Group catalogue rows into entries, one per provider.
 *
 * **Here rather than in a query**, because every surface needs the same grouping
 * and a `GROUP BY` returning JSON would put the assembly in SQL where the shape
 * cannot be parsed. `providerRecipeList` already orders joinable-first then by
 * kind and provider; this preserves the order it was given and never re-sorts,
 * so the catalogue has one order and it is stated in one place.
 */
export function atlasEntries(
  recipes: readonly ProviderRecipe[],
  /**
   * What was measured, by `kind\u0000provider` (`#545`).
   *
   * **Optional, and an absent figure is `noFigures` rather than an error.** A
   * colony where nobody has attempted a provider is the ordinary early state of
   * every entry, and a surface that could not render one would be a surface that
   * cannot show a newly written recipe.
   */
  figures: ReadonlyMap<string, AtlasFigures> = new Map(),
): readonly AtlasEntry[] {
  const byProvider = new Map<string, ProviderRecipe[]>()

  for (const recipe of recipes) {
    const held = byProvider.get(recipe.provider)
    if (held === undefined) byProvider.set(recipe.provider, [recipe])
    else held.push(recipe)
  }

  return [...byProvider.entries()].map(([provider, rows]) => {
    const joinable = rows.some((row) => row.joinable)
    const titled = rows.find((row) => row.joinable === joinable) ?? rows[0]

    return {
      provider: AccountProviderSchema.parse(provider),
      path: atlasPath(provider),
      title: titled?.title ?? provider,
      joinable,
      recipes: rows.map((row) => ({
        ...row,
        figures:
          figures.get(figureKey(row.kind, row.provider)) ?? noFigures(row.kind, row.provider),
      })),
      updatedAt: rows
        .map((row) => row.updatedAt)
        .reduce((latest, at) => (at > latest ? at : latest)),
    }
  })
}

/**
 * How a figure is looked up: the pair that identifies the recipe it measures.
 *
 * A NUL separator rather than a hyphen or a colon, because both are legal inside
 * a provider — `mail.tm` and `x-com` are ordinary values — and a separator that
 * can appear in a key is a collision waiting for the provider that contains it.
 */
export function figureKey(kind: string, provider: string): string {
  return `${kind}\u0000${provider}`
}

/**
 * The catalogue in the order a visitor should meet it (`#545`).
 *
 * **Ordered by measured outcome, never by payment**, and derived on every read
 * rather than stored — which is what makes it something nobody can buy. A
 * visitor should be able to see at a glance which providers are actually
 * passable by an agent; `#547` calls that ordering the product.
 *
 * Ties fall back to the catalogue's own order, so two unmeasured entries stay
 * where `providerRecipeList` put them rather than swapping between reads.
 */
export function atlasByOutcome(entries: readonly AtlasEntry[]): readonly AtlasEntry[] {
  return entries
    .map((entry, index) => ({
      entry,
      index,
      rank: atlasRank({
        joinable: entry.joinable,
        figures: entry.recipes.map((recipe) => recipe.figures),
      }),
    }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map((one) => one.entry)
}
