import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, not, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, type Transaction } from '../../db/src/index.js'
import { accountFigures } from '../../db/src/schema/account-figures.js'
import { accounts } from '../../db/src/schema/accounts.js'
import { accountWalks } from '../../db/src/schema/account-walks.js'
import { agents } from '../../db/src/schema/agents.js'
import { providerRecipes } from '../../db/src/schema/provider-recipes.js'
import { providerRecipeBriefings } from '../../db/src/schema/provider-recipe-briefings.js'
import { type AgentId, type ProviderId, ATLAS_CATEGORIES, AtlasCategorySchema, type AtlasCategory } from '../recipe.js'
import { atlasCategoryForKind } from './atlas-proposal.js'
import { type CatalogueRecipe, type CatalogueRecipeInput, catalogueRecipeSchema } from './catalogue.js'
import { logger } from '../../logger.js'

const ATLAS_FIGURE_FLOOR = 3

/**
 * A recipe that exists only at read time, synthesised from a measured figure.
 * It has no `provider_recipes` row and no `id` from that table.
 */
export interface MeasuredOnlyRecipe extends CatalogueRecipe {
  readonly measuredOnly: true
  readonly fallbackCategory?: true
}

/**
 * Input shape for a measured-only recipe, mirroring {@link CatalogueRecipeInput}
 * but with the measured-only flag and optional fallback marker.
 */
export interface MeasuredOnlyRecipeInput extends CatalogueRecipeInput {
  readonly measuredOnly: true
  readonly fallbackCategory?: true
}

const measuredOnlyRecipeSchema = catalogueRecipeSchema.extend({
  measuredOnly: z.literal(true),
  fallbackCategory: z.boolean().optional(),
})

export type { CatalogueRecipe, CatalogueRecipeInput }

export function isMeasuredOnlyRecipe(recipe: CatalogueRecipe): recipe is MeasuredOnlyRecipe {
  return recipe.measuredOnly === true
}

/**
 * All recipes for a provider, including those synthesised from measured figures
 * that have no `provider_recipes` row.
 */
export async function recipesForProvider(
  provider: ProviderId,
  options: { readonly tx?: Transaction } = {},
): Promise<readonly CatalogueRecipe[]> {
  const { tx } = options
  const database = tx ?? db

  const stored = await database
    .select()
    .from(providerRecipes)
    .where(eq(providerRecipes.provider, provider))
    .orderBy(asc(providerRecipes.category), asc(providerRecipes.name))

  const measured = await measuredOnlyRecipes(provider, { tx })

  return [...stored, ...measured]
}

/**
 * Synthesise catalogue entries for measured figures that have no `provider_recipes` row.
 * These are read-time entries with the same lifetime as the figure.
 */
export async function measuredOnlyRecipes(
  provider: ProviderId,
  options: { readonly tx?: Transaction } = {},
): Promise<readonly MeasuredOnlyRecipe[]> {
  const { tx } = options
  const database = tx ?? db

  const figures = await database
    .select({
      kind: accounts.kind,
      identifier: accounts.identifier,
      provider: accounts.provider,
      evidenced: accountFigures.evidenced,
      walkCount: accountFigures.walkCount,
      briefing: providerRecipeBriefings.briefing,
      briefingUpdatedAt: providerRecipeBriefings.updatedAt,
    })
    .from(accountFigures)
    .innerJoin(accounts, eq(accountFigures.accountId, accounts.id))
    .leftJoin(
      providerRecipeBriefings,
      and(
        eq(providerRecipeBriefings.provider, accounts.provider),
        eq(providerRecipeBriefings.kind, accounts.kind),
      ),
    )
    .where(
      and(
        eq(accounts.provider, provider),
        gt(accountFigures.walkCount, 0),
        isNull(accountFigures.recipeId),
      ),
    )
    .orderBy(desc(accountFigures.walkCount))

  const recipes: MeasuredOnlyRecipe[] = []
  const seenFallbackKinds = new Set<string>()

  for (const figure of figures) {
    if (!figure.evidenced) continue
    if (figure.walkCount < ATLAS_FIGURE_FLOOR) continue

    let category: AtlasCategory
    let fallbackCategory = false

    try {
      category = atlasCategoryForKind(figure.kind)
    } catch {
      category = 'data-apis'
      fallbackCategory = true

      const fallbackKey = `${figure.kind}:${provider}`
      if (!seenFallbackKinds.has(fallbackKey)) {
        seenFallbackKinds.add(fallbackKey)
        logger.warn(
          { kind: figure.kind, provider },
          'Atlas fallback category used for unknown account kind',
        )
      }
    }

    const input: MeasuredOnlyRecipeInput = {
      provider: figure.provider,
      kind: figure.kind,
      identifier: figure.identifier,
      category,
      name: figure.identifier,
      briefing: figure.briefing ?? null,
      briefingUpdatedAt: figure.briefingUpdatedAt ?? null,
      measuredOnly: true,
      fallbackCategory,
    }

    const recipe = measuredOnlyRecipeSchema.parse(input)
    recipes.push(recipe)
  }

  return recipes
}

/**
 * All recipes across all providers, including measured-only entries.
 */
export async function allRecipes(options: { readonly tx?: Transaction } = {}): Promise<readonly CatalogueRecipe[]> {
  const { tx } = options
  const database = tx ?? db

  const stored = await database
    .select()
    .from(providerRecipes)
    .orderBy(asc(providerRecipes.category), asc(providerRecipes.name))

  const figures = await database
    .select({
      provider: accounts.provider,
      kind: accounts.kind,
      identifier: accounts.identifier,
      evidenced: accountFigures.evidenced,
      walkCount: accountFigures.walkCount,
      briefing: providerRecipeBriefings.briefing,
      briefingUpdatedAt: providerRecipeBriefings.updatedAt,
    })
    .from(accountFigures)
    .innerJoin(accounts, eq(accountFigures.accountId, accounts.id))
    .leftJoin(
      providerRecipeBriefings,
      and(
        eq(providerRecipeBriefings.provider, accounts.provider),
        eq(providerRecipeBriefings.kind, accounts.kind),
      ),
    )
    .where(
      and(
        gt(accountFigures.walkCount, 0),
        isNull(accountFigures.recipeId),
      ),
    )
    .orderBy(desc(accountFigures.walkCount))

  const measured: MeasuredOnlyRecipe[] = []
  const seenFallbackKinds = new Set<string>()

  for (const figure of figures) {
    if (!figure.evidenced) continue
    if (figure.walkCount < ATLAS_FIGURE_FLOOR) continue

    let category: AtlasCategory
    let fallbackCategory = false

    try {
      category = atlasCategoryForKind(figure.kind)
    } catch {
      category = 'data-apis'
      fallbackCategory = true

      const fallbackKey = `${figure.kind}:${figure.provider}`
      if (!seenFallbackKinds.has(fallbackKey)) {
        seenFallbackKinds.add(fallbackKey)
        logger.warn(
          { kind: figure.kind, provider: figure.provider },
          'Atlas fallback category used for unknown account kind',
        )
      }
    }

    const input: MeasuredOnlyRecipeInput = {
      provider: figure.provider,
      kind: figure.kind,
      identifier: figure.identifier,
      category,
      name: figure.identifier,
      briefing: figure.briefing ?? null,
      briefingUpdatedAt: figure.briefingUpdatedAt ?? null,
      measuredOnly: true,
      fallbackCategory,
    }

    const recipe = measuredOnlyRecipeSchema.parse(input)
    measured.push(recipe)
  }

  return [...stored, ...measured]
}

/**
 * A single recipe by provider and identifier, including measured-only entries.
 */
export async function recipeByProviderAndIdentifier(
  provider: ProviderId,
  identifier: string,
  options: { readonly tx?: Transaction } = {},
): Promise<CatalogueRecipe | null> {
  const { tx } = options
  const database = tx ?? db

  const stored = await database
    .select()
    .from(providerRecipes)
    .where(and(eq(providerRecipes.provider, provider), eq(providerRecipes.identifier, identifier)))
    .limit(1)

  if (stored.length > 0) {
    return stored[0]
  }

  const figure = await database
    .select({
      kind: accounts.kind,
      identifier: accounts.identifier,
      provider: accounts.provider,
      evidenced: accountFigures.evidenced,
      walkCount: accountFigures.walkCount,
      briefing: providerRecipeBriefings.briefing,
      briefingUpdatedAt: providerRecipeBriefings.updatedAt,
    })
    .from(accountFigures)
    .innerJoin(accounts, eq(accountFigures.accountId, accounts.id))
    .leftJoin(
      providerRecipeBriefings,
      and(
        eq(providerRecipeBriefings.provider, accounts.provider),
        eq(providerRecipeBriefings.kind, accounts.kind),
      ),
    )
    .where(
      and(
        eq(accounts.provider, provider),
        eq(accounts.identifier, identifier),
        gt(accountFigures.walkCount, 0),
        isNull(accountFigures.recipeId),
      ),
    )
    .limit(1)

  if (figure.length === 0) return null

  const f = figure[0]
  if (!f.evidenced) return null
  if (f.walkCount < ATLAS_FIGURE_FLOOR) return null

  let category: AtlasCategory
  let fallbackCategory = false

  try {
    category = atlasCategoryForKind(f.kind)
  } catch {
    category = 'data-apis'
    fallbackCategory = true
    logger.warn(
      { kind: f.kind, provider: f.provider },
      'Atlas fallback category used for unknown account kind',
    )
  }

  const input: MeasuredOnlyRecipeInput = {
    provider: f.provider,
    kind: f.kind,
    identifier: f.identifier,
    category,
    name: f.identifier,
    briefing: f.briefing ?? null,
    briefingUpdatedAt: f.briefingUpdatedAt ?? null,
    measuredOnly: true,
    fallbackCategory,
  }

  return measuredOnlyRecipeSchema.parse(input)
}

/**
 * Count of recipes for a provider, including measured-only entries.
 */
export async function recipeCountForProvider(
  provider: ProviderId,
  options: { readonly tx?: Transaction } = {},
): Promise<number> {
  const { tx } = options
  const database = tx ?? db

  const storedCount = await database
    .select({ count: sql<number>`count(*)` })
    .from(providerRecipes)
    .where(eq(providerRecipes.provider, provider))

  const measuredCount = await database
    .select({ count: sql<number>`count(*)` })
    .from(accountFigures)
    .innerJoin(accounts, eq(accountFigures.accountId, accounts.id))
    .where(
      and(
        eq(accounts.provider, provider),
        gt(accountFigures.walkCount, 0),
        eq(accountFigures.evidenced, true),
        gt(accountFigures.walkCount, ATLAS_FIGURE_FLOOR - 1),
        isNull(accountFigures.recipeId),
      ),
    )

  return (storedCount[0]?.count ?? 0) + (measuredCount[0]?.count ?? 0)
}
