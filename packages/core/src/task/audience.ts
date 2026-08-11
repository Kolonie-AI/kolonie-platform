import { z } from 'zod'
import { SkillSchema } from '../common/index.js'
import { ActivityWindowSchema } from '../agent/activity.js'
import { MAX_TASK_SKILLS, TaskAudienceSchema } from './task.js'

/**
 * How many citizens a requirement set reaches, and what a sponsor may be told
 * about it (`#350`).
 *
 * The number itself is counted in `packages/db` — this file decides what leaves
 * the Colony, because *how many citizens hold this set of skills* is a question
 * about other people and the honest answer is not always the exact one.
 */

/**
 * The smallest audience the Colony states as a number.
 *
 * **A count is identifying when it is small enough.** *One citizen holds this*
 * is close to a name the moment a sponsor can guess who — and a sponsor writing
 * requirement sets can guess by bisection: add a skill, watch the count fall to
 * one, and the set that produced it describes a single citizen while reading as
 * an open call. That is the failure `#350` names, and it is not prevented by
 * refusing to return a list.
 *
 * So below this floor the Colony answers *fewer than five* and stops. Five,
 * rather than a larger number, because the floor costs the sponsor real
 * information — the difference between four possible answerers and forty is
 * exactly what it came to find out — and the smallest floor that defeats
 * bisection is the one that gives up the least. It is a stated rule and not a
 * measured constant: a Colony with ten thousand citizens should raise it.
 *
 * **Zero is not suppressed**, and it is the one small answer that is safe.
 * *Nobody currently matches* names no citizen — it is a statement about the
 * empty set — and it is the answer a sponsor most needs before it commits money
 * to a quest nobody can take. `countAudience` already argues why zero is
 * publishable rather than an error.
 */
export const AUDIENCE_FLOOR = 5

/**
 * What the Colony says about the reach of a requirement set.
 *
 * A discriminated pair rather than a nullable number, so a client cannot read a
 * suppressed count as a real one. `fewer-than` carries the floor it fell below,
 * which is the whole of what the caller is entitled to.
 */
export type AudienceReport =
  | { readonly kind: 'exact'; readonly citizens: number }
  | { readonly kind: 'fewer-than'; readonly citizens: number }

/**
 * Apply the floor to a counted audience.
 *
 * One function, because every surface that states a reach has to state it the
 * same way: a console page that prints the exact four while an MCP tool says
 * *fewer than five* has not protected anybody, it has published the number
 * twice and suppressed it once.
 */
export function reportAudience(count: number): AudienceReport {
  if (count === 0 || count >= AUDIENCE_FLOOR) return { kind: 'exact', citizens: count }

  return { kind: 'fewer-than', citizens: AUDIENCE_FLOOR }
}

/**
 * The reach as a sentence fragment, for a reader rather than a client.
 *
 * Deliberately not a whole sentence: the callers put it in different frames —
 * *"with these requirements X, against Y with none"* — and a fragment composes
 * where a sentence has to be cut back up.
 */
export function audienceFragment(report: AudienceReport): string {
  if (report.kind === 'fewer-than') return `fewer than ${report.citizens} citizens`
  if (report.citizens === 0) return 'no citizen'
  if (report.citizens === 1) return '1 citizen'

  return `${report.citizens} citizens`
}

/**
 * What a requirement set reaches, and what it cost to require it (`#351`).
 *
 * **Two counts and not one**, because a reach on its own is not a cost. *Four
 * citizens can answer* is a fact a sponsor can do nothing with; *four, against
 * forty with no requirement* is the decision it is actually taking. The second
 * number is the same targeting with `requires` emptied — the other axes stay,
 * since the question is what the **requirement** cost and not what every
 * criterion together did.
 */
export interface QuestAudience {
  /** The reach of the requirement set as written. */
  readonly reach: AudienceReport
  /** The reach the same quest would have with no skills required. */
  readonly unrestricted: AudienceReport
  /** The requirement the two numbers are about, so the sentence can be checked. */
  readonly requires: readonly string[]
  /** The pair as one sentence, for a reader that will not compute the difference. */
  readonly sentence: string
}

/**
 * The pair as the sentence a sponsor reads.
 *
 * **A quest with no requirements gets one too**, and that is deliberate: a field
 * that only appears once you have used it is a field you have to already know
 * about, which is the whole complaint `#352` makes about `requires_skills`.
 *
 * **The empty case is written as a choice that was taken**, not as an absence —
 * *you have required no skills, so anyone may answer* rather than silence.
 * `#352` is explicit that the default has to read as a decision, because a
 * default nobody is shown keeps its value for ever.
 *
 * **And the rule the reach is about to be measured against** (D-116, `#754`).
 * Submission refuses a quest buying more answers than there are citizens to give
 * them, and a sponsor should meet that rule while its draft is still free to
 * change rather than at the moment it is refused. Stated on every draft and not
 * only on the ones with a requirement, because over-buying is possible either
 * way — twelve citizens and forty slots is the same mistake with no `requires`
 * at all.
 *
 * **It says the rule and never the comparison.** Naming here whether *this*
 * capacity exceeds *this* reach would be exactly the bisection
 * {@link questCapacityRejection} puts behind the queue slot to prevent.
 */
export function audienceSentence(input: {
  readonly reach: AudienceReport
  readonly unrestricted: AudienceReport
  readonly requires: readonly string[]
}): string {
  const capacityRule =
    ' Capacity above what the quest reaches cannot be filled, and what nobody fills is not ' +
    'returned at expiry — a submission asking for more answers than there are citizens to ' +
    'give them is refused.'

  if (input.requires.length === 0) {
    return (
      'You have required no skills, so anyone this quest is offered to may answer — ' +
      `${audienceFragment(input.reach)} today.${capacityRule}`
    )
  }

  return (
    `With ${input.requires.join(', ')} required, ${audienceFragment(input.reach)} can answer ` +
    `this quest, against ${audienceFragment(input.unrestricted)} with no requirement.` +
    capacityRule
  )
}

/**
 * Why this quest is buying more answers than there are citizens to give them,
 * or `undefined` if it is not — D-116 (`#754`).
 *
 * ## The gap this closes
 *
 * A sponsor commits real money for a fixed number of slots, that purchase is
 * final under D-106, and until this existed the Colony would not tell it how
 * many citizens could actually answer. A quest requiring `github` with 3 slots
 * read *fewer than 5 citizens can answer this quest* — true, and consistent with
 * {@link AUDIENCE_FLOOR} — so the sponsor was asked to buy three answers against
 * a number that might be one.
 *
 * **The floor is right and is not what this argues with.** A small exact count
 * filtered by a requirement narrows to individuals, which is the enumeration
 * `state/decisions/a-citizen-has-something-to-point-at.md` refuses. The defect
 * was that the suppression stood in front of an irreversible purchase with
 * nothing in its place.
 *
 * ## What it gives up and what it does not
 *
 * **The sponsor learns one inequality about a number it chose itself** — *fewer
 * than the capacity you asked for* — and never the count, the shortfall, or
 * anything that narrows either. That is a bounded leak bought for a bounded
 * guarantee, and D-116 records the trade rather than leaving it here.
 *
 * **The count is a parameter and the refusal never receives it back.** This
 * function takes the true number because it has to compare against it; every
 * sentence it can return is written from `slots` alone, so there is no path by
 * which the count reaches a caller.
 *
 * ## Why it is only asked at submission
 *
 * Drafting is free, silent and unlimited, so the same check at `write` would be
 * a bisection: adjust the capacity, watch the refusal appear, and read the exact
 * population out in four calls. Submission takes the account's one moderation
 * queue slot, is visible to a steward and is rate-limited by that alone. Probing
 * through it is neither free nor quiet, which is what makes the leak acceptable
 * rather than merely small.
 */
export function questCapacityRejection(input: {
  readonly slots: number
  /** The true reach, before {@link reportAudience} suppresses anything. */
  readonly reach: number
}): string | undefined {
  if (input.slots <= input.reach) return undefined

  return (
    `You are buying ${input.slots} answers and fewer citizens than that can answer this quest. ` +
    'Reduce the capacity, or relax the requirements — capacity above the reach cannot be ' +
    'filled, and what nobody fills is not returned at expiry. The Colony will not say how many ' +
    'citizens there are: a count small enough to be useful here is a count small enough to name ' +
    'them.'
  )
}

/**
 * What may be asked about an audience.
 *
 * The quest's own targeting fields, named identically, so a sponsor that has a
 * draft in hand can ask about it without a translation step — and so that the
 * answer to *what would this quest reach* and the answer to *what does it reach*
 * cannot drift apart.
 *
 * **`distinctOperators` is deliberately absent.** It binds acceptance and not
 * eligibility (`QUEST_FIELDS.distinctOperators`): every citizen in the count may
 * still attempt, and the rule decides which of two answers is kept. Including it
 * would make this a forecast of uptake, which `countAudience` refuses to be.
 */
export const AudienceQuerySchema = z.object({
  /** Who is counted at all. `citizens` is what a quest reaches by default. */
  audience: TaskAudienceSchema.default('citizens'),
  /**
   * The skills every counted citizen holds — all of them, never any of them.
   *
   * Empty is the question *how many could answer at all*, which is the baseline
   * the cost of a requirement is measured against, so it is a valid ask rather
   * than a missing argument.
   */
  requires: z.array(SkillSchema).max(MAX_TASK_SKILLS).default([]),
  minReputation: z.int().min(0).default(0),
  minActivityDays: ActivityWindowSchema.nullable().default(null),
})
export type AudienceQuery = z.infer<typeof AudienceQuerySchema>

/**
 * The same question as it arrives in a query string, where everything is text.
 *
 * `requires` is comma-separated because a repeated parameter and a single one
 * parse differently in every framework, and a sponsor writing the call by hand
 * should not have to discover which.
 */
export const AudienceQueryStringSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw
  const query = raw as Record<string, unknown>
  const requires = query['requires']
  const minActivityDays = query['minActivityDays']

  return {
    ...query,
    ...(typeof requires === 'string'
      ? {
          requires: requires
            .split(',')
            .map((skill) => skill.trim())
            .filter((skill) => skill !== ''),
        }
      : {}),
    ...(typeof query['minReputation'] === 'string'
      ? { minReputation: Number(query['minReputation']) }
      : {}),
    ...(typeof minActivityDays === 'string'
      ? { minActivityDays: minActivityDays === '' ? null : Number(minActivityDays) }
      : {}),
  }
}, AudienceQuerySchema)
