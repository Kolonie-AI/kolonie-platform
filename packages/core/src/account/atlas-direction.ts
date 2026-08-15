import { z } from 'zod'

/**
 * Which way a verdict about a provider points (`#976`).
 *
 * **A phone number is two capabilities and the Atlas recorded one.** The Academy
 * asks for them separately — `sms.challenge` needs a number that can *receive*,
 * `sms-send` needs one that can *send* and a carrier that will register the
 * sender — and a provider that fails one is routinely fine at the other. Nothing
 * distinguished them, so `agentphone.ai` sat `refused` on a refusal every clause
 * of which was about outbound registration, and a citizen sent to earn `phone`
 * read *this provider is closed* about a provider nobody had ever tested for the
 * thing it needed.
 *
 * **A field and not prose in a caution.** The walls were being written down —
 * the `telephony` cautions name the carrier errors an agent hits, and every one
 * of them points one way — but a sentence is not something the shelf ordering
 * can see or a caller can ask for, so the entry sank for everybody regardless of
 * what they came for.
 *
 * `both` is a verdict somebody measured on both counts. It is not the same as
 * the unscoped null — see {@link directionAnswers}, where the difference between
 * *measured both ways* and *nobody wrote down which way* is the whole point.
 *
 * **It lives in its own module because two layers need it and neither may
 * import the other.** `ProviderReportRequestSchema` in `account.ts` takes a
 * direction at the door and `ProviderRecipeSchema` in `recipe.ts` carries one on
 * the shelf, and `recipe.ts` already imports `account.ts`.
 */
export const RecipeDirectionSchema = z.enum(['inbound', 'outbound', 'both'])
export type RecipeDirection = z.infer<typeof RecipeDirectionSchema>

/**
 * The kinds where the axis means anything (`#976`).
 *
 * **One, and the list is here so the second one is a data change rather than an
 * archaeology exercise.** A mailbox has the same argument available to it and
 * nobody has made it: receiving is proved by `email-inbox` and sending by
 * `email-send`, and the two do come apart at providers that take the signup and
 * refuse outbound. It is left off because nothing has been recorded against it
 * either way, and a required argument on a kind nobody has measured buys a
 * refusal rather than a fact.
 */
export const DIRECTIONAL_KINDS: readonly string[] = ['phone']

/** Whether a verdict about this kind of account has a direction to it (`#976`). */
export function kindHasDirection(kind: string): boolean {
  return DIRECTIONAL_KINDS.includes(kind)
}

/**
 * Whether a verdict scoped to `scope` answers a reader asking about `asked`
 * (`#976`).
 *
 * **A null scope answers everything, and that is the conservative direction.**
 * An unscoped verdict is one recorded before anybody thought to ask which way it
 * pointed; reading it as *inbound only* would hide a real refusal from half the
 * readers who need it. The cost of the other choice is the defect this module
 * exists for, and the fix for that is scoping the verdicts — which is a
 * backfill, not a default.
 *
 * `both` on either side answers the other: a verdict covering both directions
 * answers a reader asking about one, and a reader asking about both is asking
 * for whatever there is.
 */
export function directionAnswers(
  scope: RecipeDirection | null,
  asked: RecipeDirection | undefined,
): boolean {
  if (asked === undefined) return true
  if (scope === null) return true
  return scope === 'both' || asked === 'both' || scope === asked
}

/**
 * What a reader asking about one direction is told, given a verdict scoped to
 * another (`#976`).
 *
 * **`unwritten` and not the refusal**, because the Atlas already has a word for
 * *nobody has been here* and that is the true answer: a provider refused for
 * sending has not been refused for receiving, it has been left alone. Handing
 * back the refusal is precisely the defect; handing back nothing would drop the
 * entry off the shelf, and an unwalked entry is worth listing — it is where the
 * next walk comes from.
 *
 * **Only a refusal is rewritten, and the caution always goes.** A refusal is the
 * one status that tells a reader not to bother, so it is the one that costs
 * something when it is about the wrong capability. `measured` costs nothing —
 * its figures are counts of attempts and they are true whichever way the agents
 * were going — and rewriting it would throw away evidence to fix a verdict that
 * was never in the way. The caution is dropped in every case because it is the
 * prose this whole axis exists to replace: a wall a carrier puts in front of
 * *sending* is not a warning to a reader who came to *receive*, and asking them
 * to work that out from the wording is what the field is for.
 */
export function directionScoped<
  T extends { status: string; refusal: string | null; caution: string | null },
>(entry: T, scope: RecipeDirection | null, asked: RecipeDirection | undefined): T {
  if (directionAnswers(scope, asked)) return entry

  return {
    ...entry,
    ...(entry.status === 'refused' ? { status: 'unwritten', refusal: null } : {}),
    caution: null,
  }
}
