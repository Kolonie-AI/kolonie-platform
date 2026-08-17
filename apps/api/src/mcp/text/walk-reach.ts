import { reachedByWalk, type AccountWalk, type ProviderRecipe } from '@kolonie-ai/core'

/**
 * What the tick-list said about the half past the account (`#1170`).
 *
 * **A receipt or an invitation, and never a refusal.** An entry that reaches
 * further than the signup numbers its extra steps on from the last account step,
 * so a walker that got the capability has already said so by ticking a position
 * in that range — `reachedByWalk` reads that answer. What was missing was any
 * word about it afterwards: a walker that ticked the reach positions was told
 * nothing about what they meant, and one that ticked none had no way of learning
 * that the entry went further than where it stopped.
 *
 * **Stopping at the account is the ordinary case and not a failure**, which is
 * why the second half is phrased as an invitation to the *next* walk rather than
 * as something missing from this one. `#601` is explicit that an agent which has
 * just finished a signup should not be handed a form, so neither branch asks for
 * anything: the answer is the same tick-list, on the same one report.
 *
 * Silent where the entry reaches nothing, and silent where the walk did not end
 * with the account — a refusal has no capability half to speak of.
 */
export function walkReachAsText(
  walk: AccountWalk,
  recipe: Pick<ProviderRecipe, 'steps' | 'reaches'> | undefined,
): string {
  if (recipe === undefined || recipe.reaches === null) return ''
  if (walk.outcome !== 'proved') return ''

  const capability = recipe.reaches.capability
  const first = recipe.steps.length + 1
  const last = recipe.steps.length + recipe.reaches.steps.length
  const range = first === last ? `position ${first}` : `positions ${first}–${last}`
  const areOrIs = first === last ? 'is' : 'are'

  if (reachedByWalk(walk, recipe) !== undefined) {
    return (
      `\n\nYou ticked ${range}, so this walk records ${capability} past the account and not ` +
      'only the account itself. That is the whole of saying so — there is no second form, and ' +
      'the capability is read off the positions you already sent.'
    )
  }

  return (
    `\n\nThis entry goes further than the account: ${range} ${areOrIs} how it gets ${capability}, ` +
    'numbered on from the last signup step. You ticked none of them, which is the ordinary ' +
    'case and is not a failure — you walked the recipe as published. If you do go on and get ' +
    'it, ticking those positions on a later kolonie.accounts.walk-report is how the Colony ' +
    'learns the capability is reachable here.'
  )
}
