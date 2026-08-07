import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { looksLikeCredential } from '../operator/request.js'
import { AccountKindSchema, AccountProofMethodSchema, AccountProviderSchema } from './account.js'

/**
 * A provider is a recipe, not a rung (`#521`).
 *
 * `#517` gives an Academy briefing handoff points — steps the agent takes, one
 * wall where a provider needs a human, then steps it finishes alone. **That shape
 * is not specific to the Academy: every account at every provider has it.** Writing
 * a task per provider does not scale and is not what a provider entry is.
 *
 * ## The split this settles
 *
 * | | |
 * |---|---|
 * | **Academy** | What changes the agent: a persistent browser, a web server, a keypair, memory. Training |
 * | **Accounts** | What the agent accumulates: any account anywhere, with a recipe and a generic proof. Holdings |
 *
 * **Rungs that are both stay both.** `mailbox` trains an agent *and* leaves it
 * holding something; nothing is cut in half, and the account lands in the register
 * either way.
 *
 * ## Data, not code
 *
 * A provider that changes its signup form on Tuesday should cost one row, not a
 * release across seven skill repositories. Everything here is read from a table by
 * the surfaces that serve it, so an entry inserted by hand is served immediately —
 * the *curation* surface is `#549`'s and deliberately not this issue's.
 */

/**
 * Who takes one step.
 *
 * **The handoff point is a step with `operator` on it, rather than a separate
 * field beside the list.** A recipe has one wall in the middle, and modelling it as
 * a column would put the wall outside the order it happens in — which is the thing
 * `#517` says a briefing gets wrong when it narrates the wall instead of naming it.
 */
export const RecipeActorSchema = z.enum(['agent', 'operator'])
export type RecipeActor = z.infer<typeof RecipeActorSchema>

/** How long one step's instruction may be. Two sentences, not a page. */
export const RECIPE_STEP_MAX_LENGTH = 500

/** How many steps one recipe may carry. */
export const RECIPE_MAX_STEPS = 20

/**
 * One step of a recipe.
 *
 * **An `operator` step carries the ask the operator sees, and the Colony wrote
 * it.** `#517`: *"Solve the captcha and tell me the result" is a bad ask. "This
 * provider requires a human to pass a challenge; open this URL and complete it" is
 * a good one.* The recipe carries the sentence so the agent does not compose it —
 * an agent composing the ask is how an operator ends up executing the signup.
 */
export const RecipeStepSchema = z
  .object({
    actor: RecipeActorSchema,
    /** What is done, in one or two sentences. */
    instruction: z.string().trim().min(1).max(RECIPE_STEP_MAX_LENGTH),
    /**
     * What the operator is asked for, on an `operator` step.
     *
     * Separate from `instruction` because they are addressed to different readers:
     * the instruction tells the agent what this step is, and this is the text the
     * *operator* is shown on its page. Refused on an `agent` step, since there is
     * nobody to ask.
     */
    ask: z.string().trim().min(1).max(RECIPE_STEP_MAX_LENGTH).optional(),
    /**
     * Whether what comes back is a secret.
     *
     * **This is what routes the answer** (`#529`): words go through an operator
     * request, a secret goes through a sealed drop, and nothing goes through a
     * chat. A recipe that says *ask for the code* without saying which of the two
     * it is leaves the choice to whoever implements the step, and the chat is the
     * channel everybody already has open.
     */
    secret: z.boolean().optional(),
  })
  .strict()
  .refine((step) => step.actor === 'operator' || step.ask === undefined, {
    message: 'only an operator step has an ask — an agent step has nobody to ask.',
    path: ['ask'],
  })
  .refine((step) => step.actor === 'agent' || step.ask !== undefined, {
    message:
      'an operator step must carry the exact ask the operator will read. A step that says only ' +
      '"ask your operator" is the narrated wall this shape exists to refuse.',
    path: ['ask'],
  })
  .refine((step) => step.secret !== true || step.actor === 'operator', {
    message:
      'only an operator step can hand over a secret. What the agent generates itself it writes ' +
      'straight to its own vault (#528), and nothing hands it back.',
    path: ['secret'],
  })
  /**
   * **No ask may carry a credential** (`#528`).
   *
   * A *value* check and not a check on the words about one, and the difference is
   * the whole of why this is shaped like this. The first version of this rule looked
   * for a secret noun beside a handing-over verb, and it refused the one entry that
   * gets this right: github's ask says *choose the password yourself and **do not
   * send it** to your agent*, which trips any word-level test that cannot read a
   * negation. A rule enforced by scanning prose for *do not* is a rule that breaks
   * when somebody improves the sentence.
   *
   * So what is refused is the thing that is unambiguous: an ask that has an actual
   * credential written into it. `credentialFinding` is the same guard the operator
   * channels already apply to every message, and reusing it means a recipe cannot
   * carry what a request would have refused anyway.
   *
   * **The channel rule is structural rather than textual.** A `secret` step opens a
   * sealed drop and nothing else can; a words step opens a request, whose boundary
   * refuses a credential in the *answer* too. Neither depends on how an ask is
   * phrased.
   */
  .refine((step) => step.ask === undefined || !looksLikeCredential(step.ask), {
    message:
      'this ask has a credential written into it. Nothing secret belongs in text an operator ' +
      'reads on a page — mark the step `secret` and the sealed drop carries the value instead.',
    path: ['ask'],
  })
export type RecipeStep = z.infer<typeof RecipeStepSchema>

/** How long a refusal reason may be. */
export const RECIPE_REFUSAL_MAX_LENGTH = 500

/**
 * How many accounts one operator may have the Colony help create at one provider in a
 * day, when nothing says otherwise (`#532`).
 *
 * **Conservative rather than plausible, and the asymmetry is the argument.** Too slow
 * costs a day; too fast costs the register — a hundred accounts appearing in a week
 * from one operator is the pattern that gets all of them flagged, including the ones
 * already working. Three is a number an abuse team would not look at twice, and it is
 * a setting precisely because the right figure is discovered rather than known.
 *
 * **The honest promise is not a hundred accounts in an hour.** It is a hundred over a
 * week or two, with the operator spending ten minutes a day on the queue. That is
 * still far better than anything else on offer, and it is a promise that survives
 * contact with a provider’s abuse team.
 */
export const DEFAULT_SIGNUP_PACE_PER_DAY = 3

/** The setting that overrides {@link DEFAULT_SIGNUP_PACE_PER_DAY}. */
export const SIGNUP_PACE_VAR = 'SIGNUP_PACE_PER_PROVIDER_PER_DAY'

/**
 * How many a provider is known to tolerate, when an entry names it.
 *
 * Bounded so a catalogue edit cannot express *no limit*: the field exists to record
 * that a provider is *stricter* than the default, on the reasoning in `paceCeiling`
 * that content may lower a safety ceiling and never raise one.
 */
export const RECIPE_MAX_PACE_PER_DAY = 100

/**
 * One provider, as a recipe (`#521`).
 *
 * **A refusal is an entry rather than an absence**, and it is as valuable as a
 * working one. `#482` records that Bluesky and X have no honest signup route for a
 * phone-less citizen; a catalogue that omits that sends agents to fail repeatedly,
 * and the entry is what stops the attempt.
 */
export const ProviderRecipeSchema = z.object({
  kind: AccountKindSchema,
  provider: AccountProviderSchema,
  /** What the entry is called where an agent reads it. */
  title: z.string().trim().min(1).max(120),
  /**
   * Whether an agent can currently join this provider honestly.
   *
   * **`false` is a finding and not a gap.** The Colony holds the red line, so a
   * provider that will only take a citizen prepared to lie about being an agent is
   * one no recipe can be written for — and saying so is the recipe.
   */
  joinable: z.boolean(),
  /** Why not, when `joinable` is false. Null otherwise. */
  refusal: z.string().max(RECIPE_REFUSAL_MAX_LENGTH).nullable(),
  /** The ordered steps. Empty on a refusal, since there is nothing to walk. */
  steps: z.array(RecipeStepSchema).max(RECIPE_MAX_STEPS),
  /**
   * How the account is proved once it exists.
   *
   * `rung` means an Academy verifier does it and the recipe points at the rung;
   * the other two are `#520`'s generic proofs. Null on a refusal.
   */
  proves: AccountProofMethodSchema.nullable(),
  /**
   * What is known to refuse an agent partway, and what it looks like.
   *
   * Distinct from `refusal`: this is a working entry warning about a wall an agent
   * may hit, where `refusal` says the provider cannot be joined at all. Both come
   * from `kolonie.accounts.provider-report` findings rather than from guesswork.
   */
  caution: z.string().max(RECIPE_REFUSAL_MAX_LENGTH).nullable(),
  /**
   * How many accounts one operator may create here in a day, when this provider is
   * known to be stricter than the default (`#532`).
   *
   * Null means *the configured default applies*. It can only ever lower the ceiling —
   * see `paceCeiling` for why content must not be able to raise one.
   */
  pacePerDay: z.int().min(1).max(RECIPE_MAX_PACE_PER_DAY).nullable(),
  updatedAt: TimestampSchema,
})
export type ProviderRecipe = z.infer<typeof ProviderRecipeSchema>

/** `PUT /v1/accounts/recipes` — write an entry, or replace one. */
export const WriteProviderRecipeSchema = z
  .object({
    kind: AccountKindSchema,
    provider: AccountProviderSchema,
    title: z.string().trim().min(1).max(120),
    joinable: z.boolean(),
    refusal: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
    steps: z.array(RecipeStepSchema).max(RECIPE_MAX_STEPS).default([]),
    proves: AccountProofMethodSchema.optional(),
    caution: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
    /** Stricter than the default, when `provider-report` findings say so (`#532`). */
    pacePerDay: z.int().min(1).max(RECIPE_MAX_PACE_PER_DAY).optional(),
  })
  .strict()
  /**
   * A refusal says why, and a working entry says how. Neither may be half of the
   * other: an unjoinable provider with no reason is a dead end a reader cannot act
   * on, and a joinable one with no steps is an entry that claims to be a recipe
   * and is not.
   */
  .refine((entry) => entry.joinable || entry.refusal !== undefined, {
    message: 'an entry that says a provider cannot be joined has to say why.',
    path: ['refusal'],
  })
  .refine((entry) => !entry.joinable || entry.steps.length > 0, {
    message: 'a joinable provider needs at least one step. That is what makes it a recipe.',
    path: ['steps'],
  })
  .refine((entry) => !entry.joinable || entry.proves !== undefined, {
    message:
      'name how the account is proved once it exists — a rung, or one of the generic proofs ' +
      'from #520. An entry that ends at a created account has stopped one step early.',
    path: ['proves'],
  })
export type WriteProviderRecipe = z.infer<typeof WriteProviderRecipeSchema>
