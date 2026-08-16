import type { ProviderReportOutcome } from './account.js'
import type { WalkOutcome } from './walk.js'
import type { WalkedRecipe, WalkedRecipeWall, WallKind } from './walked-recipe.js'

/**
 * One fact, one surface: a provider verdict, read as the walk it always was
 * (`#1036`).
 *
 * ## Why there were two
 *
 * `kolonie.accounts.provider-report` (`#298`) and `kolonie.accounts.walk-report`
 * (`#601`) were built eleven weeks apart to answer the same question — *what
 * happened when a citizen went to this provider* — and answered it into two
 * tables with two shapes, two moderation queues and two sets of counts. A
 * citizen that hit a payment wall could say so twice and be counted twice, or
 * say so once and be counted on whichever shelf the reader did not open.
 *
 * So the report becomes a walk. This is the whole of the conversion, in one
 * place, called by the retiring alias at the door and by the data migration that
 * moved the rows already written — because a mapping applied twice from two
 * copies is the same failure the merge is fixing.
 *
 * ## The table is not the implementer's to invent
 *
 * `#1036` fixes it, and it is reproduced here rather than paraphrased:
 *
 * | report outcome      | walk outcome | wall kind                          |
 * | ------------------- | ------------ | ---------------------------------- |
 * | `no-service`        | `refused`    | `other`, saying nothing answered    |
 * | `cannot-do-the-job` | `refused`    | `other`, naming what it cannot do   |
 * | `signup-refused`    | `refused`    | whichever of the nine it hit        |
 * | `never-provisioned` | `refused`    | `other`                             |
 * | `abandoned`         | `abandoned`  | none — a wall is only on a refusal  |
 *
 * The last row is the existing check constraint
 * `account_walks_wall_only_on_a_refusal` and not a choice made here: a walk that
 * was abandoned carries no wall, so an abandoned report converts to a walk with
 * nothing said about what stopped it, which is exactly what `abandoned` meant.
 *
 * `signup-refused` is the one row with a degree of freedom, and the alias has no
 * way to exercise it: a report says *it turned me down* and never which of the
 * nine walls did it. So it converts to `other` with a sentence saying the kind
 * was not recorded, which is true and is what makes it findable as *a refusal
 * whose kind nobody knows* rather than mislabelled as one somebody measured.
 * A citizen that knows says so on `kolonie.accounts.walk-report`, where the
 * question is asked.
 */

/**
 * The Colony's own sentence for each converted verdict.
 *
 * **Not the citizen's `reason`, and this is the point rather than an
 * omission.** The reason was written to answer *where exactly did it stop you*
 * on a different form, it is moderated on its own queue, and only
 * `scrubbedReason` is ever readable. Promoting unmoderated prose into a wall
 * the Atlas publishes would put words in front of readers that nobody cleared,
 * and promoting the scrubbed version would put a sentence answering one question
 * under a heading asking another. So the wall says what the outcome said, in the
 * Colony's voice, and the citizen's sentence stays where it was written.
 */
const CONVERTED_WALL: Readonly<Record<Exclude<ProviderReportOutcome, 'abandoned'>, string>> = {
  'no-service': 'Nothing answered at this provider — no working service behind the name at all.',
  'cannot-do-the-job':
    'The provider’s own documentation says the account cannot do what this kind is for, so ' +
    'signup was never attempted.',
  'signup-refused':
    'The provider turned the walker down at signup. Which of the nine walls it was is not on ' +
    'this record: it was filed as a provider report, which never asked.',
  'never-provisioned': 'Signup appeared to succeed and the account never worked.',
}

/** Which of the nine each verdict converts to. `signup-refused`: see above. */
const CONVERTED_KIND: Readonly<Record<Exclude<ProviderReportOutcome, 'abandoned'>, WallKind>> = {
  'no-service': 'other',
  'cannot-do-the-job': 'other',
  'signup-refused': 'other',
  'never-provisioned': 'other',
}

/** A converted verdict, in the shape {@link WalkStore.submit} takes. */
export interface ReportAsWalk {
  readonly outcome: WalkOutcome
  /** The sentence column, present exactly where the outcome is `refused`. */
  readonly wall?: string
  /** The typed half, which is what `withWalls` and `excludeWalls` filter on. */
  readonly recipe?: WalkedRecipe
}

/**
 * Convert one provider verdict into the walk it describes (`#1036`).
 *
 * **Every synthesised wall carries a `symptom`.** `SubmittedWalkedRecipeSchema`
 * requires one where the kind is `other`, and four of the five outcomes map to
 * `other` — so a conversion that omitted it would produce a recipe the door
 * would refuse from a citizen, which is the definition of a shape the Colony
 * should not be writing on a citizen's behalf either.
 */
export function providerReportAsWalk(outcome: ProviderReportOutcome): ReportAsWalk {
  if (outcome === 'abandoned') return { outcome: 'abandoned' }

  const symptom = CONVERTED_WALL[outcome]
  const wall: WalkedRecipeWall = { kind: CONVERTED_KIND[outcome], symptom }

  return { outcome: 'refused', wall: symptom, recipe: { walls: [wall] } }
}
