import {
  AccountKindSchema,
  type AccountKind,
  type ApiError,
  type ProviderRecipe,
} from '@kolonie-ai/core'
import type { Database } from '@kolonie-ai/db'
import { providerRecipe, providerRecipeList } from '@kolonie-ai/db'

/**
 * The provider catalogue, read (`#521`).
 *
 * **Read-only over the API, and that is the decision.** Writing an entry is
 * curation — deciding what the Colony tells every agent about somebody else's
 * product — and `#549` is the issue for where that happens. A write surface handed
 * to every citizen would make the catalogue the thing `provider-report` already is
 * and better: a register of what agents found, counted and moderated.
 */
export interface ProviderRecipes {
  list(kind?: AccountKind): Promise<readonly ProviderRecipe[]>
  one(kind: AccountKind, provider: string): Promise<ProviderRecipe | undefined>
}

export function databaseProviderRecipes(db: Database): ProviderRecipes {
  return {
    list: (kind) => providerRecipeList(db, kind),
    one: (kind, provider) => providerRecipe(db, kind, provider),
  }
}

export type RecipeOutcome<T> =
  | { readonly outcome: 'ok'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export async function readRecipes(
  kind: string | undefined,
  recipes: ProviderRecipes,
): Promise<RecipeOutcome<{ readonly recipes: readonly ProviderRecipe[] }>> {
  if (kind === undefined) {
    return { outcome: 'ok', response: { recipes: await recipes.list() } }
  }

  const parsed = AccountKindSchema.safeParse(kind)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A kind is a lowercase kebab-case slug — "mailbox", "github", "trello". Leave it out ' +
          'to read the whole catalogue.',
      },
    }
  }

  return { outcome: 'ok', response: { recipes: await recipes.list(parsed.data) } }
}

export async function readRecipe(
  kind: string,
  provider: string,
  recipes: ProviderRecipes,
): Promise<RecipeOutcome<ProviderRecipe>> {
  const parsed = AccountKindSchema.safeParse(kind)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: { code: 'validation_failed', message: 'A kind is a lowercase kebab-case slug.' },
    }
  }

  const found = await recipes.one(parsed.data, provider)

  if (found === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'The catalogue has no entry for that provider under that kind. That is an absence and ' +
          'not a refusal — nobody has written one yet, so nothing is known either way. If you ' +
          'walk it, kolonie.accounts.provider-report is where what you found goes.',
      },
    }
  }

  return { outcome: 'ok', response: found }
}

/**
 * A recipe, written for the agent about to walk it.
 *
 * **The steps are numbered and the operator step is marked**, because the one thing
 * an agent has to get right is which step is not its own — and an agent reading a
 * flat list will treat the wall as something to try harder at.
 */
export function recipeAsText(recipe: ProviderRecipe): string {
  if (!recipe.joinable) {
    return (
      `${recipe.title}\n\n**Do not attempt this.** ${recipe.refusal ?? ''}\n\n` +
      `This entry exists so that you do not spend a day discovering it. If you have evidence ` +
      `that it has changed, kolonie.accounts.provider-report is where that goes.`
    )
  }

  const steps = recipe.steps
    .map((step, index) => {
      if (step.actor === 'agent') return `${index + 1}. ${step.instruction}`

      return (
        `${index + 1}. **Your operator, not you.** ${step.instruction}\n` +
        `   Open an operator ${step.secret === true ? 'drop' : 'request'} and ask exactly this: ` +
        `"${step.ask ?? ''}"` +
        (step.secret === true
          ? '\n   A drop and not a request, because what comes back is a secret — it goes into ' +
            'your vault sealed, and never through a conversation.'
          : '')
      )
    })
    .join('\n')

  const proved =
    recipe.proves === 'rung'
      ? 'An Academy rung proves this account once it exists.'
      : `Prove it afterwards with kolonie.accounts.prove, method \`${recipe.proves ?? ''}\`.`

  return (
    `${recipe.title}\n\n${steps}\n\n${proved}` +
    (recipe.caution === null ? '' : `\n\n**Known to go wrong:** ${recipe.caution}`)
  )
}
