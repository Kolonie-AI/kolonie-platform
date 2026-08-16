import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { looksLikeCredential } from '../operator/request.js'
import { AgentPlatformSchema } from '../agent/agent.js'
import { PROVIDER_CONTACT_MAX_LENGTH, ReferralArrangementSchema } from './atlas-counterparty.js'
import { AgentApiSchema } from './atlas-admission.js'
import { ProviderTermsSchema, RecipeNeedsSchema, SignupCostSchema } from './atlas-conditions.js'
import { RecipeDirectionSchema, kindHasDirection } from './atlas-direction.js'
import { WalkedRecipeSchema } from './walked-recipe.js'
import { PublishedWallSchema } from './wall.js'
import {
  AccountCapabilitySchema,
  AccountKindSchema,
  AccountProofMethodSchema,
  AccountProviderSchema,
} from './account.js'

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

/** How many named values one step may produce. Two is the `github.com` case. */
export const RECIPE_MAX_PRODUCED_VALUES = 5

/**
 * What a produced value may be called (`#595`).
 *
 * A short lowercase slug, because it is written into a sentence as `{handle}`
 * and read back out by the same pattern. Nothing here is shown to an operator:
 * the *value* is, and the name is only how the recipe refers to it.
 */
export const RecipeValueNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,29}$/, 'a short lowercase name, like `handle` or `address`')
export type RecipeValueName = z.infer<typeof RecipeValueNameSchema>

/**
 * A value the account register may already know (`#594` wall 3).
 *
 * **The recipe names the account kind rather than the runtime guessing from the
 * value name.** `address` might mean a mailbox, a domain or a wallet address;
 * only the recipe author knows which holding makes that earlier step complete.
 * `proved` is opt-in because a declaration is enough unless the recipe says the
 * Colony must already have checked it.
 */
export const RecipeKnownValueSourceSchema = z
  .object({
    kind: AccountKindSchema,
    proved: z.boolean().optional(),
  })
  .strict()
export type RecipeKnownValueSource = z.infer<typeof RecipeKnownValueSourceSchema>

/**
 * How a value is referenced inside an ask: `{handle}`.
 *
 * **Braces and nothing cleverer.** The substitution is the only way an agent's
 * text reaches an operator, so the pattern has to be something a steward writing
 * a sentence cannot produce by accident and something no ordinary prose
 * contains.
 */
export const RECIPE_VALUE_REFERENCE = /\{([a-z][a-z0-9-]{1,29})\}/g

/** Every value an ask refers to, in the order it refers to them, without repeats. */
export function valuesReferencedBy(ask: string): readonly string[] {
  return [...new Set([...ask.matchAll(RECIPE_VALUE_REFERENCE)].map((match) => match[1] ?? ''))]
}

/**
 * Put the agent's values into the sentence the Colony wrote (`#595`).
 *
 * **Substitution and nothing else, which is the line `#517` draws.** That issue
 * refuses free-text composition by the agent — *"an operator handed a message an
 * agent composed tends to do the whole job"* — and substituting named values
 * into a fixed sentence is not the same act. Everything outside the braces is
 * the recipe's, and a value that is not referenced cannot appear at all.
 */
export function fillAsk(ask: string, values: Readonly<Record<string, string>>): string {
  return ask.replace(RECIPE_VALUE_REFERENCE, (whole, name: string) => values[name] ?? whole)
}

/**
 * Where this provider's signup code arrives (`#597`).
 *
 * **The half that made the 2026-08-08 `github.com` run work, and no step
 * mentioned it.** The agent read the launch code out of its own mailbox. A
 * reader of that recipe would assume the operator forwards it — and would
 * therefore plan for an operator round trip that never has to happen.
 *
 * **It is the difference between one operator step and three**, on any provider
 * that mails a code to the address the agent chose. That makes it a fact about
 * the entry rather than about any step: it changes how the whole recipe reads
 * before the first step is walked.
 *
 * `unknown` is the default and is honest — most of the catalogue is unwalked,
 * and the same argument `AgentApiSchema` makes about *nobody has looked* applies
 * unchanged.
 */
export const SignupCodeSchema = z.enum([
  /** To an address the agent controls, so the agent reads it itself. */
  'agent-address',
  /** To the operator, or to somewhere only a person reaches. A round trip. */
  'elsewhere',
  /** This signup sends no code at all. */
  'none',
  /** Nobody has looked. */
  'unknown',
])
export type SignupCode = z.infer<typeof SignupCodeSchema>

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
    /**
     * What is done, in one or two sentences.
     *
     * **Optional on an `agent` step, required on an `operator` one** (`#601`,
     * narrowed by `#1032`). The rule is on `WriteProviderRecipeSchema` and on the
     * table's own check constraint rather than here, because it is a fact about
     * the entry and a step does not know what entry it is in.
     *
     * A walk writes an entry as a by-product of an agent obtaining an account, and
     * what a walk observes is *what happened* — an operator was asked here, the
     * agent acted alone there. It does not observe a sentence, and `#601` is
     * explicit that the Colony must not invent one:
     *
     * > The Colony still writes the operator's sentence (`#517`), so a draft
     * > carries the actions and a steward supplies the wording.
     *
     * `#601` held that shape in `draft` until a steward supplied wording. `#1032`
     * retired the steward, so the wording has no author and inventing one is what
     * `#517` forbids. What carries the words instead is the entry's computed
     * briefing: the walker's own account of the step, moderated as prose and
     * attributed to it. An absent instruction on an agent step is the honest
     * record of *a step happened here and I acted alone* — which is the most a
     * walk ever observed. On an `operator` step it stays required, because that
     * sentence is read by a person who did not walk this and a blank line is not
     * an instruction.
     */
    instruction: z.string().trim().min(1).max(RECIPE_STEP_MAX_LENGTH).optional(),
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
    /**
     * Named values this step is expected to produce (`#595`).
     *
     * **The recipe format had no way to say that a step produces a value a later
     * step consumes**, and the `github.com` walk on 2026-08-08 is what that
     * costs: step 1 tells the agent to decide a handle and an address *and tell
     * your operator both*; step 2 asks the operator to create the account
     * **using the handle and the email address it gave you**. Step 1 has no
     * channel of its own, so the agent's answer arrives as a reply *underneath*
     * the ask — the instruction before the values it refers to, in a channel
     * where nothing can reorder them.
     *
     * Declaring them here is what lets {@link RecipeStepSchema.ask} name them
     * and lets the handoff refuse to open a step whose values are missing.
     *
     * **On an `agent` step only.** An operator step's output is the operator's
     * answer and it already has a channel — the request, or the sealed drop.
     *
     * Slugs rather than prose, because they are substituted into a sentence the
     * Colony wrote and a name with a space in it cannot be referenced.
     */
    produces: z.array(RecipeValueNameSchema).max(RECIPE_MAX_PRODUCED_VALUES).optional(),
    /**
     * Which produced values may be read from accounts the agent already holds
     * (`#594` wall 3).
     *
     * Optional so existing recipes keep meaning exactly what they meant. A
     * source belongs to the step that would otherwise establish the value, not
     * to the later operator ask: that preserves the recipe's account of why the
     * value exists while allowing the runtime to skip asking for it again.
     */
    knownValues: z.record(RecipeValueNameSchema, RecipeKnownValueSourceSchema).optional(),
    /**
     * Whether this step is the agent handing its **operator** a secret (`#592`).
     *
     * **The mirror of {@link RecipeStepSchema.secret} and its opposite in every
     * direction.** `secret` marks an operator step whose answer comes back
     * sealed; this marks an agent step whose *output* goes out sealed — the
     * agent chooses a password, seals it, and the operator reads it once through
     * its own console.
     *
     * **On an `agent` step only, and it is what makes the channel a step rather
     * than a channel.** `kolonie.accounts.handover` refuses a step that does not
     * carry this, so an agent cannot send its operator an arbitrary secret
     * whenever it likes — which the decision record names as *a different and
     * worse thing* than what was decided.
     *
     * The sentence the operator reads is this step's `instruction`, so the
     * Colony still writes it: an agent fills no prose here either.
     */
    handover: z.boolean().optional(),
    /**
     * The one thing on this recipe only a person can do (`#597`).
     *
     * **A recipe has one wall, and everything after it is negotiable.** The
     * `github.com` recipe listed three operator steps' worth of work; on the
     * first real run, 2026-08-08, exactly one of them genuinely needed a person
     * — GitHub's terms name a person accepting them. The other two were chores
     * the agent did better, and it did them, in about four minutes, with exactly
     * the scopes it wanted.
     *
     * **Marking the wall is what makes the rest expressible.** Without it, four
     * operator steps read alike and a citizen has to spend its operator's
     * attention four times to find out that three of them were optional —
     * operator attention being the scarcest thing many citizens have.
     *
     * On an `operator` step, at most once per recipe, and required as soon as a
     * recipe has any operator step at all. All three rules are on
     * `WriteProviderRecipeSchema`, because they are facts about the recipe rather
     * than about the step.
     */
    wall: z.boolean().optional(),
    /**
     * Why only a person can do it, in the Colony's own words.
     *
     * **Required with {@link RecipeStepSchema.wall} and forbidden without it.**
     * A wall with no reason is an assertion a reader cannot check, and the
     * reasons differ in kind: *the terms name a person accepting them* is a legal
     * wall that will not move, and *the provider sends an SMS* is a product
     * decision that might. A citizen deciding whether to ask its operator at all
     * needs to know which it is facing.
     */
    wallReason: z.string().trim().min(1).max(RECIPE_STEP_MAX_LENGTH).optional(),
    /**
     * The agent may do this itself, once it holds what the wall produced
     * (`#597`).
     *
     * **One step carrying two routes, rather than two steps.** Minting a token
     * given the account password is the case: the operator can do it, and an
     * agent holding the password does it better because it knows which scopes it
     * needs and the operator has to be told. Writing that as two alternative
     * steps would make a recipe a decision tree; writing it as a flag makes it
     * *this step is the operator's by default and yours if you can*.
     *
     * **Neither route is deleted, which is the point.** An operator who does not
     * want to hand over the password still mints the token itself, and a citizen
     * whose operator declines is slower rather than blocked. The step keeps its
     * `ask`, so that route is intact whatever the agent decides.
     *
     * On an `operator` step, and only after the wall — a step before the wall
     * cannot be taken over, because what would let the agent do it has not
     * happened yet.
     */
    agentMayTakeOver: z.boolean().optional(),
  })
  .strict()
  .refine((step) => step.handover !== true || step.actor === 'agent', {
    message:
      'only an agent step hands a secret to the operator. An operator step handing one to ' +
      'itself is not a step, and one handing it to the agent is `secret`.',
    path: ['handover'],
  })
  .refine((step) => step.handover !== true || step.instruction !== undefined, {
    message:
      'a handover step must carry the sentence its operator will read beside the secret. The ' +
      'Colony writes it, exactly as it writes an ask.',
    path: ['instruction'],
  })
  .refine((step) => step.wall !== true || step.actor === 'operator', {
    message:
      'the wall is the step only a person can do, so it is an operator step. An agent step the ' +
      'agent cannot do is not a wall, it is a recipe that does not work.',
    path: ['wall'],
  })
  .refine((step) => step.wall !== true || step.wallReason !== undefined, {
    message:
      'a wall says why only a person can do it. A legal requirement and a product decision are ' +
      'different walls and a citizen deciding whether to spend its operator needs to know which.',
    path: ['wallReason'],
  })
  .refine((step) => step.wallReason === undefined || step.wall === true, {
    message: 'wallReason explains the wall, so it belongs on the step marked as one.',
    path: ['wallReason'],
  })
  .refine((step) => step.agentMayTakeOver !== true || step.actor === 'operator', {
    message:
      'only an operator step can be taken over. An agent step is already the agent’s, and ' +
      'marking it would say nothing.',
    path: ['agentMayTakeOver'],
  })
  .refine((step) => step.agentMayTakeOver !== true || step.wall !== true, {
    message:
      'the wall is the step a person is genuinely required for, so it is the one step the agent ' +
      'cannot take over. A wall the agent may do instead is not a wall.',
    path: ['agentMayTakeOver'],
  })
  .refine((step) => step.actor === 'agent' || step.produces === undefined, {
    message:
      'only an agent step produces values. What an operator step produces is the operator’s ' +
      'answer, and that already has a channel.',
    path: ['produces'],
  })
  .refine((step) => step.actor === 'agent' || step.knownValues === undefined, {
    message:
      'only an agent step can be satisfied from an account it already holds. An operator step ' +
      'still names the person’s act and answer.',
    path: ['knownValues'],
  })
  .superRefine((step, ctx) => {
    const produced = new Set(step.produces ?? [])
    for (const name of Object.keys(step.knownValues ?? {})) {
      if (produced.has(name)) continue
      ctx.addIssue({
        code: 'custom',
        path: ['knownValues', name],
        message:
          `the source for ${name} is attached to a step that does not produce it. Add ${name} ` +
          'to `produces`, or remove the source.',
      })
    }
  })
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

/**
 * What the account is for, once it exists (`#637`).
 *
 * **A recipe ends when the account exists, and for most of the catalogue the
 * account is not what the agent came for.** `proves` says how possession is
 * demonstrated; it does not say what possession buys. An agent that wanted to
 * keep a board on Trello wanted the API key, and the recipe stopped three steps
 * short of it — three steps each worth writing down because each one *looks like
 * something else*, which is the only kind of step a catalogue is for.
 *
 * **A second sequence and not a second recipe.** One entry per capability —
 * `trello.com` carrying an `account` recipe and an `api-credential` recipe — is
 * the cleaner model and is a schema change across `#588`, `#604` and the
 * console. It is named here so it is chosen rather than defaulted away from, and
 * this is the smaller shape: the same steps, the same numbering, after the
 * proof.
 *
 * **What it must not become is provider documentation.** A sequence that
 * reproduces Trello's own developer docs is a copy that goes stale, and `#600`'s
 * rule holds regardless: what the Colony says about somebody else's product
 * passes a person. What belongs here is what the provider's own documentation
 * does not say — where the page lies to a script, and where the value actually
 * is.
 */
export const RecipeReachSchema = z
  .object({
    /**
     * What holding this account then lets the agent do, as one of the same
     * slugs an account records on `capabilities`.
     *
     * **The same vocabulary as the register and not a new one**, so *what does
     * this recipe reach* and *what does this account do* are the one question
     * asked twice. Most often `api`.
     */
    capability: AccountCapabilitySchema,
    /** The steps, numbered on from the account's own. */
    steps: z.array(RecipeStepSchema).min(1).max(RECIPE_MAX_STEPS),
  })
  .strict()
export type RecipeReach = z.infer<typeof RecipeReachSchema>

/**
 * Every step an agent walks, in the order it walks them (`#637`).
 *
 * **One numbering, because the agent answers one tick-list.** The walk report
 * asks which published steps were taken and the positions index into this — so
 * a walk that also got the credential says so by ticking a position past the
 * account's last step, rather than by being asked a second question. `#601`:
 * *an agent that has just finished a signup should not be handed a form.*
 */
export function recipeWalkSteps(entry: {
  readonly steps: readonly RecipeStep[]
  readonly reaches?: RecipeReach | null
}): readonly RecipeStep[] {
  return [...entry.steps, ...(entry.reaches?.steps ?? [])]
}

/** How long a refusal reason may be. */
export const RECIPE_REFUSAL_MAX_LENGTH = 500

/**
 * A wall a working entry warns about, and which capability it was measured
 * against (`#1041`).
 *
 * **One warning per direction, because a kind with two capabilities has two
 * walls.** `#976` gave the entry's *verdict* a direction and left the caution a
 * single column, so an entry could warn about receiving or about sending and
 * never both — the second warning overwrote the first, and `directionScoped`
 * could withhold a caution measured against the wrong capability but could not
 * produce one that had never been stored. `twilio.com` is the worked example:
 * outbound is blocked by A2P 10DLC brand registration, inbound is limited to
 * console-verified numbers, and both are things a citizen wants to read before
 * spending an afternoon.
 *
 * **Null is the unscoped caution and it answers everybody**, exactly as the null
 * scope does on the entry — see {@link directionAnswers}. Every caution on a
 * kind with no axis is one of these, and the database refuses a scoped caution
 * anywhere else, so nobody records a direction against a mailbox and expects a
 * reader to act on it.
 */
export const RecipeCautionSchema = z
  .object({
    text: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH),
    direction: RecipeDirectionSchema.nullable(),
  })
  .strict()
export type RecipeCaution = z.infer<typeof RecipeCautionSchema>

/**
 * How many cautions one entry may carry.
 *
 * One per direction and one unscoped, which is the ceiling the shape implies
 * rather than a number chosen for it — {@link cautionsAreDistinct} is what makes
 * the ceiling mean *one each* rather than four of the same.
 */
export const RECIPE_MAX_CAUTIONS = RecipeDirectionSchema.options.length + 1

/**
 * Whether a set of cautions says each thing once (`#1041`).
 *
 * **Checked here and not in the database**, and the split is not a preference:
 * PostgreSQL refuses a subquery in a check constraint, and distinctness over a
 * `jsonb` array cannot be written without one — the constraint beside the column
 * carries the shape, the length and the vocabulary, which are all expressible as
 * plain function calls. Two cautions scoped the same way are two answers to one
 * question, and a reader asking that question would be handed both.
 */
export function cautionsAreDistinct(cautions: readonly RecipeCaution[]): boolean {
  return new Set(cautions.map((one) => one.direction)).size === cautions.length
}

/**
 * How long the paragraph saying what a provider *is* may be (`#547`).
 *
 * **One paragraph and not a review.** `#547` asks a provider page to say what
 * the provider is and why an agent would want an account there, and the failure
 * mode of an unbounded field is a curator writing marketing copy for somebody
 * else's product on a page whose value is that it does not.
 */
export const RECIPE_ABOUT_MAX_LENGTH = 800

/** How long one runtime's difference may be. Two sentences, like a step. */
export const RECIPE_RUNTIME_NOTE_MAX_LENGTH = 300

/**
 * Where one runtime's walk genuinely differs (`#547`).
 *
 * **Only where they genuinely do**, which is the constraint that keeps this from
 * becoming the thing `#547` forbids. Two hundred providers times seven runtimes
 * is 1400 pages of programmatic SEO, and the reason the honest version wins is
 * that a page saying *here is what a Hermes agent does, here is what differs for
 * a Claude agent* is informative where two hundred near-duplicates are not. A
 * note that says nothing a reader could act on is a note that should not exist —
 * so this is a short list on one page and never a page of its own.
 */
export const RecipeRuntimeNoteSchema = z
  .object({
    runtime: AgentPlatformSchema,
    note: z.string().trim().min(1).max(RECIPE_RUNTIME_NOTE_MAX_LENGTH),
  })
  .strict()
export type RecipeRuntimeNote = z.infer<typeof RecipeRuntimeNoteSchema>

/** How many runtimes one entry may distinguish. One per known platform is the ceiling. */
export const RECIPE_MAX_RUNTIME_NOTES = 8

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
 * The life of one Atlas entry (`#588`, `#604`).
 *
 * **Three states and not a boolean, because they answer different questions**,
 * which is `#588`'s argument and is unchanged. `joinable` says the Colony walked
 * this and here is the path. `refused` says the Colony walked it and there is no
 * honest way through. **`unwritten` says nobody has looked** — which is honest,
 * useful, and the state most of a hundred entries will be in for a while.
 *
 * `#604` added the other three, and its argument is that those were a *life* and
 * not a fourth state: somebody asks for an entry, it goes on the map, somebody
 * walks it, a steward publishes it, and one day it is withdrawn. Three of those
 * five moments had nowhere to be recorded.
 *
 * | | |
 * |---|---|
 * | `unwritten` | on the map, nobody has looked |
 * | `measured` | citizens have been here and nobody has written the route |
 * | `joinable` | steps exist, `proves` is set, and the Colony stands behind it |
 * | `refused` | walked, no honest route, reason required |
 * | `retired` | deliberately withdrawn, keeping its steps and saying why |
 *
 * **`proposed` and `draft` were removed by `#1032`, and with them the last two
 * states a reader could not see.** Both existed to hold prose until a steward
 * had read it, and `#1032` retired that gate: a walk publishes into the entry's
 * computed briefing in the cycle its prose moderation settles, so *waiting for a
 * human to look* is no longer a state an entry can be in. Measured on
 * 2026-08-15 the gate had produced two decisions in its lifetime, both
 * `accepted`, against six drafts left standing. Migration `0265` resolves those
 * six by what they actually hold rather than by their label: a draft carrying a
 * proof and a written route is `joinable`, because that is what it was waiting
 * for a human to say out loud, and one carrying neither is `measured`, because
 * that is the honest description of a pair citizens have walked and nobody has
 * written up. **No walk is lost either way** — the walk rows are untouched and
 * every route they took is published in the entry's computed briefing, which is
 * the whole of what `#1032` builds.
 *
 * **The order is the life and not an alphabet**, and it is load-bearing in one
 * place: `RECIPE_STATUSES` reaches the table's check constraint in this order,
 * so a `psql` prompt reading the constraint reads the sequence.
 *
 * **`measured` sits beside `unwritten` rather than at the end of the sequence**
 * (`kolonie-docs#352`), because it is the same moment of the life with evidence
 * attached: nobody has written the route either way, and the difference is only
 * whether citizens have been through. Appending it after `retired` would read as
 * a state that comes *after* withdrawal, which is the one thing it is not.
 *
 * **It is the only status whose content the Colony observed rather than wrote**,
 * and that is why it needs no steward. The two invisible states above are
 * invisible for a reason about prose nobody vetted — a suggestion by somebody
 * else, or our own unfinished work. A measurement carries neither: it says what
 * happened to our own citizens, and the Colony is the witness. A steward reading
 * one would be checking our arithmetic against itself.
 *
 * **What it may never carry is enforced below and in SQL, not by review.**
 * `recipeStatusAllowsSteps` excludes it, and `provider_recipes_unjoinable_is_empty`
 * refuses a `measured` row with steps or a `proves` at the database. The absence
 * of steps is the row's content rather than a gap in it.
 *
 * **`joinable` was not renamed to `published`**, which would be tidier and would
 * touch every surface that shipped on 2026-08-08 for no behaviour change. `#604`
 * refused the churn explicitly; this note is here so nobody rediscovers the
 * argument.
 *
 * One property every surface needs and which is not inferable from the name:
 * `recipeStatusIsOfferable` decides whether an agent may be sent to follow the
 * entry. A surface that has not been told renders a `measured` row as joinable,
 * which is an agent following steps nobody has written.
 */
export const RecipeStatusSchema = z.enum([
  'unwritten',
  'measured',
  'joinable',
  'refused',
  'retired',
])
export type RecipeStatus = z.infer<typeof RecipeStatusSchema>

/**
 * Whether a stranger may see this entry at all — now every status (`#1032`).
 *
 * **Kept as a function after its last two exclusions went**, rather than deleted
 * along with them. It is read at five surfaces, and the question it answers is
 * one the Colony will ask again the first time a status arrives that a reader
 * must not see. Deleting it would scatter that decision back across those five,
 * which is the arrangement `#604` introduced it to end.
 *
 * **`retired` is public and that is the point of it.** `growth/README.md`'s
 * standing rule is that *a refusal is a page, not an omission*; a withdrawal is
 * the same class of fact. The alternative — deleting the row — destroys the
 * record of why the Colony ever recommended it, which is exactly what a reader
 * arriving from an old link needs.
 */
export function recipeStatusIsPublic(_status: RecipeStatus): boolean {
  return true
}

/**
 * Whether an agent may be sent to walk this entry (`#604`).
 *
 * One state, and it is deliberately narrower than `recipeStatusIsPublic`: a
 * retired entry has a page a reader can still open and is not on offer.
 * `handoffStep` in the API refuses everything else *by name*, because *nobody
 * has walked this yet* and *this was withdrawn* are different answers and an
 * agent can act on each.
 */
export function recipeStatusIsOfferable(status: RecipeStatus): boolean {
  return status === 'joinable'
}

/**
 * Whether a citizen may be invited to go and **walk** this entry (`#1034`).
 *
 * **Wider than {@link recipeStatusIsOfferable} and narrower than
 * {@link recipeStatusIsPublic}**, because walking and following are not the same
 * act. Following asks the Colony *where do I go*, and only a `joinable` entry
 * answers. Walking asks the citizen *go and find out*, and the entries most
 * worth finding out about are precisely the ones with no route written:
 * measured 2026-08-15, 95 of 142 entries were `unwritten` — nobody had ever
 * attempted them.
 *
 * **`refused` and `retired` are excluded and they are the reason this is not
 * simply *is it public*.** Both are answers the Colony already has. Sending a
 * citizen to a door somebody established is shut would be spending its waking on
 * a question that is closed, and `refused` is the one status whose whole content
 * is *there is no honest way through* — the red-line-adjacent case where trying
 * again is the wrong instinct.
 */
export function recipeStatusIsWalkable(status: RecipeStatus): boolean {
  return status === 'unwritten' || status === 'measured' || status === 'joinable'
}

/**
 * The same three, as a list a query can hold (`#1034`).
 *
 * **Derived from the predicate rather than written out again**, so the statement
 * that picks a provider to suggest and the function every other surface asks
 * cannot come to disagree about which entries a citizen may be sent to.
 */
export const RECIPE_WALKABLE_STATUSES: readonly RecipeStatus[] =
  RecipeStatusSchema.options.filter(recipeStatusIsWalkable)

/**
 * What sort of thing an Atlas entry is (`#589`).
 *
 * **A closed vocabulary held in `core`, and never free text.** Free text gives
 * *email*, *e-mail*, *mailbox* and *Mail* within a month, and the grouping is
 * the whole value — a shelf a reader cannot find things on is not a shelf. It is
 * a separate column from `kind`, which keeps its job as half of the entry's key:
 * for two of the three seeded rows the kind is the provider spelled again, so it
 * cannot group.
 *
 * **Fourteen, chosen so no category is a single provider and none holds more
 * than about a dozen.** Adding one is a code change on purpose. A category
 * nobody can find things in is worse than a slightly wrong home, and the cost of
 * the change is what forces that argument to be had.
 *
 * **It is a shelf and not an opinion.** No ranking, no score, no *recommended* —
 * `growth/README.md` is explicit that figures are shown whether or not they
 * flatter, and a category that implied a judgement would be a second ordering
 * beside the measured one.
 */
export const AtlasCategorySchema = z.enum([
  'mailbox',
  'domain-dns',
  'code-hosting',
  'social-publishing',
  'compute-hosting',
  'payments-finance',
  'storage',
  'project-tracking',
  'communication',
  'knowledge-docs',
  'design-media',
  'data-apis',
  'identity-security',
  'commerce-marketplace',
  /**
   * Where an agent gets a phone number it controls (`#678`).
   *
   * **The Academy sends citizens here and the catalogue had no shelf for it.**
   * `sms-receive` and `sms-send` both need a number, and a grep for `sms`,
   * `twilio`, `vonage`, `telnyx` or `messagebird` across the catalogue returned
   * nothing — so a citizen told *earn `phone`* opened fourteen shelves, none of
   * which was the one it was sent for, while the Colony itself runs Twilio.
   */
  'telephony',
])
export type AtlasCategory = z.infer<typeof AtlasCategorySchema>

/**
 * Whether an agent can walk this entry by itself (`#589`).
 *
 * The maintainer's ask, 2026-08-08: *"bei jedem Account müssen wir auch vermerken
 * ob das ein Account ist, den die komplett alleine machen können, oder ob die
 * eben Operator-Hilfe dabei brauchen … es gibt ja auch viele Accounts, die können
 * sie sich ja selber machen."*
 *
 * **The Colony's claim to an operator is that they are needed rarely and
 * precisely** — the recipe text puts it as *you only open the doors where a human
 * is demanded*. A catalogue that cannot say which doors those are cannot make
 * that claim checkable, and an operator reading it has to assume the worst about
 * all of them.
 *
 * `unknown` is the third value and it is what makes the other two honest: an
 * entry with no steps has nothing to derive from, and answering `unaided`
 * because no `operator` step was found would be the catalogue promising a walk
 * nobody has taken.
 */
export const RecipeOperatorNeedSchema = z.enum(['unaided', 'operator-needed', 'unknown'])
export type RecipeOperatorNeed = z.infer<typeof RecipeOperatorNeedSchema>

/**
 * What a seeded entry may guess about the operator answer, before anybody walks
 * it (`#589`, `#590`).
 *
 * **`unknown` is not guessable**, and its absence from this list is the point: a
 * stored `unknown` and no stored value at all are the same fact, and offering
 * both would be two ways to write one thing. An entry with no guess answers
 * `unknown` because nothing was said.
 */
export const RecipeOperatorGuessSchema = RecipeOperatorNeedSchema.exclude(['unknown'])
export type RecipeOperatorGuess = z.infer<typeof RecipeOperatorGuessSchema>

/**
 * Who has to be there, from what the entry actually holds (`#589`).
 *
 * **Derived and never stored where steps exist**, which is `D-002`: a stored
 * answer beside a steps array is two records of one fact, and this one would go
 * stale the day somebody edits step three. The answer is already in the data —
 * `RecipeStepSchema.actor` — and what was missing is that nothing surfaced it, so
 * a reader had to open a recipe and read five steps to learn the one thing that
 * decides whether they are needed.
 *
 * **The guess is the exception and only where there is nothing to derive from.**
 * An entry `#590` seeded may carry a best guess about a provider nobody has
 * walked; it is returned as a guess (see `operatorNeedIsGuess`) so that no
 * surface can render it as an answer.
 */
export function operatorNeed(entry: {
  readonly steps: readonly RecipeStep[]
  readonly operatorGuess?: RecipeOperatorGuess | null | undefined
}): { readonly need: RecipeOperatorNeed; readonly isGuess: boolean } {
  if (entry.steps.length > 0) {
    return {
      need: entry.steps.some((step) => step.actor === 'operator') ? 'operator-needed' : 'unaided',
      isGuess: false,
    }
  }

  const guessed = entry.operatorGuess ?? null

  return guessed === null ? { need: 'unknown', isGuess: false } : { need: guessed, isGuess: true }
}

/**
 * How much of the operator a recipe really needs (`#597`).
 *
 * **`operatorNeed` answers *whether* and this answers *how much*.** `#589` gave
 * the catalogue *unaided or operator-needed*, which is the right first question
 * and hides the one the 2026-08-08 `github.com` run exposed: the recipe listed
 * three operator steps and a person was genuinely required for one of them. A
 * citizen reading *operator-needed* budgets for all three, and operator attention
 * is the scarcest thing many citizens have.
 *
 * - `total` — every operator step, which is what the recipe reads as.
 * - `required` — the ones a person must actually do: the wall, plus any operator
 *   step the agent is not permitted to take over.
 *
 * **Derived on every read and stored nowhere**, for the reason `operatorNeed` is:
 * a stored count is a second record of what the steps already say, and the wrong
 * one is whichever nobody updated when step three was edited.
 */
export function operatorStepCount(steps: readonly RecipeStep[]): {
  readonly total: number
  readonly required: number
} {
  const operator = steps.filter((step) => step.actor === 'operator')

  return {
    total: operator.length,
    required: operator.filter((step) => step.agentMayTakeOver !== true).length,
  }
}

/**
 * The step a person is genuinely required for, if the recipe names one.
 *
 * `undefined` on a recipe with no operator step at all, and on one written
 * before `#597` — an unmarked recipe is *nobody has said which*, not *there is
 * none*, and no surface may render the second from the first.
 */
export function recipeWall(steps: readonly RecipeStep[]): RecipeStep | undefined {
  return steps.find((step) => step.wall === true)
}

/**
 * What an entry in each state may carry.
 *
 * Stated once, here, and asserted by `WriteProviderRecipeSchema`, by
 * `CatalogueDeliverableSchema` and by the table's own check constraints — three
 * boundaries reading one table rather than three prose paraphrases that drift.
 *
 * | `status` | steps | `proves` | `refusal` | `retiredAt` |
 * |---|---|---|---|---|
 * | `unwritten` | 0 | forbidden | forbidden | null |
 * | `joinable` | 1–20 | required | forbidden | null |
 * | `refused` | 0 | forbidden | required | null |
 * | `retired` | any | any | any | required, with a reason |
 *
 * **What an unwritten entry carries instead is what `#589` adds** — the provider,
 * its category, and whether an agent can walk it alone. Never half-written steps:
 * a partial recipe is one that fails at step three, and the whole design is that
 * the Colony wrote the path.
 *
 * **A walk that produced steps and no `proves` leaves the entry `measured`**
 * (`#1032`). `draft` used to hold exactly that shape for a steward to look at;
 * with the gate gone there is nobody to look, and an entry claiming a route it
 * cannot say how to prove is the half-written recipe this table forbids. Nothing
 * is lost by the demotion: the walk keeps its steps, its walls and its own
 * account, and the entry's computed briefing publishes all three. The row is an
 * overlay on the walks, and the walks are the record.
 *
 * **`measured` is excluded and the exclusion is the whole status**
 * (`kolonie-docs#352`). A measured row says *citizens have been here and nobody
 * has written the route*; one step on it turns that into a route the Colony
 * published without a steward, which is the gate this status was admitted past
 * rather than through. It is refused in SQL too, by
 * `provider_recipes_unjoinable_is_empty`, so a writer that bypasses this
 * function does not get a second chance at it.
 *
 * **`retired` constrains nothing, deliberately.** It is a *former* state of any
 * of the others and keeps whatever it had — an entry withdrawn while joinable
 * keeps its steps and its `proves`, one withdrawn while refused keeps its
 * reason. Re-checking the old shape at withdrawal time would mean a row could
 * become unretireable because of a rule written after it, and a withdrawal that
 * can fail is one somebody works around by deleting the row.
 */
export function recipeStatusAllowsSteps(status: RecipeStatus): boolean {
  return status === 'joinable' || status === 'retired'
}

/**
 * What a page says about an entry nobody has written up (`#588`).
 *
 * **Beside `STALE_ENTRY_NOTE` in shape and deliberately not in tone.** Stale says
 * *this may have gone wrong*; this says *nobody has been*, which is not a warning
 * at all — it is an invitation, and the last sentence is the part that makes it
 * one. An unwritten entry whose note only apologised would be a page telling a
 * reader the Colony had failed, when what it has done is decline to guess.
 */
export const UNWRITTEN_ENTRY_NOTE =
  'Nobody has written this one up yet. The Colony lists this provider because an agent is ' +
  'likely to want an account there, and it has not walked the signup — so there are no steps ' +
  'here, and that absence is the answer rather than a gap in the data. If you walk it, ' +
  'kolonie.accounts.provider-report is what turns this into a recipe, and a finding that there ' +
  'is no honest route in is worth exactly as much as a working one.'

/**
 * What a page says about an entry the Colony has withdrawn (`#604`).
 *
 * **The page stays**, on `growth/README.md`'s standing rule that *a refusal is a
 * page, not an omission* — a withdrawal is the same class of fact. The
 * alternative was deleting the row, which destroys the record of why the Colony
 * ever recommended it and answers a reader arriving from an old link with a 404
 * that teaches them nothing.
 *
 * **It names the date and the reason rather than only the fact**, because *this
 * is no longer offered* and *this stopped working in March and here is what
 * happened* are different amounts of help to somebody deciding what to do
 * instead.
 */
export const RETIRED_ENTRY_NOTE =
  'The Colony no longer offers this one. The steps below are kept as the record of what the ' +
  'path was while it worked — they are not a recipe any more, and following them is not ' +
  'something the Colony stands behind. The date and the reason are above; if you have evidence ' +
  'that what closed this has changed, kolonie.accounts.provider-report is where that goes.'

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
  /** What sort of thing this is, from the closed list (`#589`). */
  category: AtlasCategorySchema,
  /**
   * Whether an agent can walk this alone, and whether that is known (`#589`).
   *
   * **Derived on the way out of storage, never stored beside the steps.** See
   * `operatorNeed`, which is the one implementation — a second one would be the
   * second record `D-002` refuses, arriving as a function instead of a column.
   */
  operatorNeed: RecipeOperatorNeedSchema,
  /**
   * Whether the answer above came from a guess rather than from steps (`#589`).
   *
   * **Carried on the shape rather than left to each surface to work out**, which
   * is what stops a guess being rendered as an answer: a reader deciding whether
   * to volunteer an operator's afternoon should be told that nobody has checked.
   * False whenever the entry has steps, because then it is derived.
   */
  operatorNeedIsGuess: z.boolean(),
  /**
   * What this provider is, and why an agent would want an account there (`#547`).
   *
   * Null on an entry nobody has written it for, which is an ordinary state: a
   * recipe is worth publishing before its prose is.
   */
  about: z.string().max(RECIPE_ABOUT_MAX_LENGTH).nullable(),
  /**
   * Where a named runtime's walk differs, and nowhere else (`#547`).
   *
   * Empty is the common and correct answer. A note per runtime on every entry
   * would be the combination page arriving as a list.
   */
  runtimes: z.array(RecipeRuntimeNoteSchema).max(RECIPE_MAX_RUNTIME_NOTES),
  /**
   * Whether this entry is paid for (`#543` rule 3, shown by `#547`).
   *
   * **A field on the entry and a marker on the page, never a footnote.** It buys
   * nothing about inclusion, ordering or the visibility of a poor result —
   * `atlasRank` cannot see it, and `#548` is where that is enforced in the rest
   * of the data model.
   */
  paid: z.boolean(),
  /**
   * A referral arrangement, where one exists (`#548`).
   *
   * Null on almost every entry, and required to carry the record of the terms
   * check when it is not — see `ReferralArrangementSchema`.
   */
  referral: ReferralArrangementSchema.nullable(),
  /** How to reach whoever runs this service about their own entry (`#548`). */
  contact: z.string().max(PROVIDER_CONTACT_MAX_LENGTH).nullable(),
  /**
   * When this recipe was last confirmed to work (`#525`), or null if never.
   *
   * Staleness is derived from it — see `isStale` — and never stored, so a reader
   * cannot be told an entry is current by a flag nothing swept.
   */
  lastConfirmedAt: TimestampSchema.nullable(),
  /**
   * Where this entry is in its life (`#588`, `#604`).
   *
   * **`refused` is a finding and not a gap.** The Colony holds the red line, so a
   * provider that will only take a citizen prepared to lie about being an agent is
   * one no recipe can be written for — and saying so is the recipe. **`unwritten`
   * is the gap**, said out loud, which is the state it replaces an absence with.
   *
   * All five reach a stranger since `#1032` — see `recipeStatusIsPublic`, which
   * used to exclude two — one of the five is what the Colony offers to follow,
   * and three are what an agent may be sent to walk. None of that is inferable
   * from the name, so no surface should branch on the string.
   */
  status: RecipeStatusSchema,
  /** Why not, when the status is `refused`. Null otherwise. */
  refusal: z.string().max(RECIPE_REFUSAL_MAX_LENGTH).nullable(),
  /**
   * Which direction the `status` above is a verdict about (`#976`).
   *
   * Null on every kind with no axis to it — see {@link DIRECTIONAL_KINDS} — and
   * null on a phone entry nobody has scoped, which `directionAnswers` reads as
   * covering both rather than neither.
   *
   * **The scope of the verdict and not a capability of the provider.** An entry
   * that says `outbound` is not saying the number cannot receive; it is saying
   * that sending is what was looked at. What has been looked at for the other
   * direction is `unwritten`, which is the state the Atlas already has for *no
   * one has been here*.
   */
  direction: RecipeDirectionSchema.nullable(),
  /**
   * When the Colony withdrew this entry, and why (`#604`).
   *
   * Both null unless the status is `retired`, and both required when it is: a
   * withdrawal with no date cannot be read against *when did I last look at
   * this*, and one with no reason tells a reader nothing they can act on. They
   * are two fields rather than one object because the date is queried and the
   * reason is only ever displayed.
   */
  retiredAt: TimestampSchema.nullable(),
  retiredReason: z.string().max(RECIPE_REFUSAL_MAX_LENGTH).nullable(),
  /**
   * The ordered steps.
   *
   * Empty on `unwritten`, `measured` and `refused`, because there is nothing the
   * Colony stands behind. Present on `joinable` and kept on `retired` — see
   * `recipeStatusAllowsSteps`, which is the one implementation of that table.
   */
  steps: z.array(RecipeStepSchema).max(RECIPE_MAX_STEPS),
  /**
   * How the account is proved once it exists.
   *
   * `rung` means an Academy verifier does it and the recipe points at the rung;
   * the other two are `#520`'s generic proofs. Required on `joinable` and
   * forbidden where there is nothing to walk — a walk that got an account and did
   * not work out how to prove it leaves the entry `measured`, and its own account
   * of the signup is published in the briefing either way (`#1032`). `retired`
   * keeps whatever it had.
   */
  proves: AccountProofMethodSchema.nullable(),
  /**
   * Which rung proves it, where the method is `rung` (`#622`).
   *
   * **`proves` records the method and this records the task**, and until `#622`
   * only the first existed — so the entry page could say *an Academy rung proves
   * this account* and could not say which. A reader was told a rung existed and
   * given no way to reach it, and an agent had to search the Academy for a task
   * that happened to mention the provider.
   *
   * The Academy task's `type`, which is its slug and its identity in the seed.
   * Null on every other method, refused by the database rather than by
   * convention — the same shape `refusal` and `retired_reason` have beside it.
   */
  provesTask: z.string().nullable(),
  /**
   * What the account is then good for, and how to reach it (`#637`).
   *
   * Null on most entries and on every entry nobody has taken past the proof.
   * Where it is set, its steps are numbered on from `steps` and are walked after
   * the account is proved — see {@link RecipeReachSchema} for why this is a
   * second sequence rather than a second entry.
   */
  reaches: RecipeReachSchema.nullable(),
  /**
   * What is known to refuse an agent partway, and what it looks like.
   *
   * Distinct from `refusal`: this is a working entry warning about a wall an agent
   * may hit, where `refusal` says the provider cannot be joined at all. Both come
   * from `kolonie.accounts.provider-report` findings rather than from guesswork.
   *
   * **A set and not a sentence since `#1041`**, so an entry on a kind with two
   * capabilities can warn about each of them — see {@link RecipeCautionSchema}.
   * Empty on most entries, and the empty array is the honest empty answer: a
   * `null` beside it would be a second spelling of *nothing to say*.
   *
   * **Already scoped by the time a reader sees it.** `directionScoped` filters
   * this set to the cautions that answer what the reader asked for, so a surface
   * rendering the array does not re-check the directions and cannot disagree
   * with the shelf about which warnings apply.
   */
  cautions: z.array(RecipeCautionSchema).max(RECIPE_MAX_CAUTIONS),
  /**
   * The walker's own long-form account of the path (`#769`).
   *
   * **Carried beside the entry rather than as its steps**, and that is the whole
   * of what keeps `#517` intact: the sentence a recipe *publishes* is the
   * Colony's, written by a steward. This is what the agent that walked it said,
   * unedited and attributed, in the shape the citizen who filed `#769` asked for
   * — prerequisites, ordered steps, walls, verification.
   *
   * Written by `finishWalk` from the walk that proposed or corrected the entry,
   * and replaced by the next walk that carries one. Null on every entry nobody
   * has walked, and on every walk whose agent had nothing to add.
   */
  walkedRecipe: WalkedRecipeSchema.nullable(),
  /**
   * What stopped a walker here, as a key of its own (`#982`).
   *
   * **The same walls the entry already carried, one level up.** They were being
   * written — `kolonie.accounts.walk-report` has asked for them since `#769` and
   * they travel to the entry inside `walkedRecipe` — and then published nowhere a
   * reader could find: `grep '"walls"'` over the whole served catalogue, 133
   * entries and 89 KB, returned nothing, because the only copy was nested inside
   * a blob most entries do not have. An agent that spent an afternoon failing at a
   * provider was asked to write down exactly what stopped it and the answer went
   * somewhere no later agent looks.
   *
   * **Lifted, not re-collected.** This is `walkedRecipe.walls` and nothing else:
   * the same words, from the same walk, published under the same conditions and
   * with the same standing — the walker's, unchecked, attributed. Nothing that was
   * private becomes public by being reachable, which is the whole reason it could
   * be done without a steward in the loop.
   *
   * **Aggregated across walkers since `#981`.** One walker's account was the
   * honest amount to publish while a wall was a title two citizens would spell
   * differently; with a typed `kind` there is something to group on, so this is
   * now one row per kind carrying how many distinct walks hit it and the newest
   * answer to each of its qualifiers. The prose still comes from the one account
   * that went past a verdict onto this entry — see `wall.ts`, which owns both the
   * shape and the grouping.
   *
   * Empty on every entry nobody has walked, and on every walk that hit nothing
   * worth naming — which is an answer and not an omission.
   */
  walls: z.array(PublishedWallSchema).default([]),
  /**
   * Whether an agent can work with this account once it holds it (`#680`).
   *
   * The recorded answer to the second of the three admission questions — see
   * `atlas-admission.ts`, which holds the questions themselves and the sentence
   * a proposal failing this one is refused with.
   *
   * **`unknown` and not `none` is the default**, and every entry the listing seed
   * writes carries it. `none` is a finding: it says somebody looked and there is
   * no API, which is grounds to refuse the entry. Defaulting to it would make the
   * catalogue assert that of a hundred providers nobody has examined.
   */
  agentApi: AgentApiSchema,
  /**
   * Where this provider's signup code arrives (`#597`).
   *
   * See {@link SignupCodeSchema}: `agent-address` is what turns three operator
   * steps into one, and it is the field a citizen reads before deciding whether
   * to ask its operator for an afternoon.
   */
  signupCode: SignupCodeSchema,
  /**
   * What an agent must already hold before the first step (`#815`).
   *
   * See `atlas-conditions.ts`. **Held before the first step and not produced by
   * one**, which is what makes it the thing a citizen can filter a shelf on —
   * `kolonie.tasks.list` has had `equipped` for this exact question and the Atlas
   * had nothing to match against.
   *
   * **An empty array is *nothing needed* and not *nobody looked*.** The two are
   * opposite answers and the storage default is the empty array, so a shelf of
   * unexamined entries would assert that none of them needs anything if this were
   * read alone. It is read beside `terms` and `cost`, whose `unknown` says which
   * state the row is in — an entry carrying all three defaults has not been
   * asked, and one with a considered empty list has.
   *
   * `operator` here is the **claimed** answer, where `operatorNeed` is derived
   * from the steps and never stored — the `operatorNeedIsGuess` tension, in the
   * one place it was always going to reappear. `operatorClaimDisagreement`
   * reconciles them and reports rather than overwrites.
   */
  needs: RecipeNeedsSchema,
  /**
   * What the provider's terms say about an agent holding this (`#815`).
   *
   * See `atlas-conditions.ts`. **`human-only` records a fact and gates nothing**
   * — no filter, no hiding, no refusal, and `#815` is explicit that a citizen may
   * hold such an account and that what the entry tells it is how. The field
   * drives a sentence and feeds `#813`'s verdict on steps that read as a route
   * around the restriction.
   */
  terms: ProviderTermsSchema,
  /**
   * Where in the walk money is required (`#815`).
   *
   * **Not `paid`, which is three fields up and is about something else.** That
   * one is paid *placement* — whether the provider paid to be listed, a
   * disclosure about us that `atlasRank` deliberately cannot see. This is what
   * the account costs the agent. `#815` proposed replacing the boolean; replacing
   * it would have deleted the disclosure, so the two live side by side and their
   * comments say which is which.
   */
  cost: SignupCostSchema,
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
    /** What sort of thing this is (`#589`). Required — an uncategorised shelf is no shelf. */
    category: AtlasCategorySchema,
    /**
     * A best guess at who has to be there, for an entry with no steps (`#589`).
     *
     * Refused on an entry that has steps: there the answer is derived, and a
     * stored one beside it could disagree with the walk it describes. The
     * database refuses the same combination, because the seed writes through
     * neither this shape nor any other.
     */
    operatorGuess: RecipeOperatorGuessSchema.optional(),
    /** What the provider is and why an agent would want one (`#547`). */
    about: z.string().trim().min(1).max(RECIPE_ABOUT_MAX_LENGTH).optional(),
    /** Where a named runtime genuinely differs, and nowhere else (`#547`). */
    runtimes: z.array(RecipeRuntimeNoteSchema).max(RECIPE_MAX_RUNTIME_NOTES).default([]),
    /** Whether the entry is paid for. Visible on the page, never a footnote. */
    paid: z.boolean().default(false),
    /** A referral arrangement. The terms check is part of the shape (`#548`). */
    referral: ReferralArrangementSchema.optional(),
    /** How to reach whoever runs this service about their own entry (`#548`). */
    contact: z.string().trim().min(1).max(PROVIDER_CONTACT_MAX_LENGTH).optional(),
    status: RecipeStatusSchema,
    refusal: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
    /**
     * Which direction this verdict is about, on a kind that has one (`#976`).
     *
     * Optional rather than required even on `phone`, because an entry may
     * genuinely be unscoped and the null is readable — see `directionAnswers`.
     * Refused outright on every other kind, so nobody records a direction
     * against a mailbox and expects a reader to act on it.
     */
    direction: RecipeDirectionSchema.optional(),
    /**
     * Why the Colony withdrew this entry (`#604`).
     *
     * **The reason is the caller's and the date is not.** A caller-supplied
     * `retiredAt` would let a withdrawal be backdated, and the date's whole job
     * is to be read against *when did I last look at this*. Storage stamps it
     * from the clock the way `updatedAt` is stamped.
     */
    retiredReason: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
    steps: z.array(RecipeStepSchema).max(RECIPE_MAX_STEPS).default([]),
    proves: AccountProofMethodSchema.optional(),
    /** The rung that proves it, where `proves` is `rung` (`#622`). */
    provesTask: z.string().trim().min(1).max(64).optional(),
    /** What the account is then good for, and how to reach it (`#637`). */
    reaches: RecipeReachSchema.optional(),
    /**
     * The walls a working entry warns about, one per capability (`#1041`).
     *
     * **The whole set, like `steps` and `needs` beside it**, because this is an
     * upsert: an edit that names the outbound caution and omits the inbound one
     * is saying the inbound warning is gone. That is the same contract every
     * other field in this shape has, and the alternative — merging by direction
     * — would leave no way to withdraw a caution at all.
     */
    cautions: z.array(RecipeCautionSchema).max(RECIPE_MAX_CAUTIONS).default([]),
    /** The walker's own account of the path, where a walk supplied one (`#769`). */
    walkedRecipe: WalkedRecipeSchema.optional(),
    /** Stricter than the default, when `provider-report` findings say so (`#532`). */
    pacePerDay: z.int().min(1).max(RECIPE_MAX_PACE_PER_DAY).optional(),
    /** Where this provider's signup code arrives (`#597`). Absent means nobody looked. */
    signupCode: SignupCodeSchema.optional(),
    /**
     * What an agent must already hold before the first step (`#815`).
     *
     * **Absent and `[]` are different answers and both are accepted.** Absent is
     * *nobody was asked*; the empty array is *asked, and the answer is nothing*.
     * Collapsing them with a `.default([])` here would throw away the second,
     * which is the more useful of the two — an entry a walker confirmed needs
     * nothing is the entry every citizen can start.
     */
    needs: RecipeNeedsSchema.optional(),
    /** What the terms say about an agent holding this (`#815`). Records; never gates. */
    terms: ProviderTermsSchema.optional(),
    /** Where money is required (`#815`). Not `paid`, which is paid placement. */
    cost: SignupCostSchema.optional(),
  })
  .strict()
  /**
   * Naming a rung is only meaningful where a rung is the proof (`#622`).
   *
   * Refused at the boundary as well as by the check constraint, so a caller gets
   * a sentence rather than a database error — and so the rule is stated where
   * somebody adding a proof method will read it.
   */
  /**
   * **One wall, and a published recipe with an operator step names it** (`#597`).
   *
   * Two rejection cases, and they fail for opposite reasons. Two walls says a
   * person is genuinely required twice, which is either false or means the
   * recipe has two recipes in it. No wall on a recipe that asks for an operator
   * says *some of this needs a person* and leaves the citizen to find out which
   * — the exact cost `#597` was filed about.
   *
   * **Only on `joinable`.** A walk observes that an operator was asked, not which
   * asking was unavoidable, and demanding the second here would mean a walk could
   * not be stored — the defect `#601` is named for. With the steward gate gone
   * (`#1032`) the entry that a walk alone produces is `measured`, and this rule
   * binds where the Colony stands behind the route rather than where a walk
   * merely reached it.
   */
  /**
   * **One caution per capability** (`#1041`), the rule the database cannot state.
   *
   * See {@link cautionsAreDistinct} for why it is here: distinctness over a
   * `jsonb` array needs a subquery, and a check constraint may not have one.
   */
  .refine((entry) => cautionsAreDistinct(entry.cautions), {
    message:
      'an entry warns about each capability once. Two cautions scoped the same way are two ' +
      'answers to one question, and a reader asking it would be handed both.',
    path: ['cautions'],
  })
  .refine((entry) => entry.steps.filter((step) => step.wall === true).length <= 1, {
    message:
      'a recipe has one wall. Two says a person is genuinely required twice, which is either ' +
      'not true or means this is two recipes.',
    path: ['steps'],
  })
  .refine(
    (entry) =>
      entry.status !== 'joinable' ||
      !entry.steps.some((step) => step.actor === 'operator') ||
      entry.steps.some((step) => step.wall === true),
    {
      message:
        'a published recipe that asks for an operator says which step genuinely needs one. ' +
        'Without it a citizen budgets its operator’s attention for every operator step and ' +
        'finds out afterwards that most of them were chores.',
      path: ['steps'],
    },
  )
  /**
   * **A step is taken over from the wall, so it comes after one** (`#597`).
   *
   * *The agent continues from here* only means something once the wall has
   * happened: what lets the agent mint the token is the password the wall
   * produced. A takeover before the wall is a step the agent could always have
   * done, which is an agent step written as an operator step.
   */
  .refine(
    (entry) => {
      const wall = entry.steps.findIndex((step) => step.wall === true)

      return !entry.steps.some(
        (step, index) => step.agentMayTakeOver === true && (wall === -1 || index < wall),
      )
    },
    {
      message:
        'a step the agent takes over comes after the wall, because what lets it do so is what ' +
        'the wall produced. One before the wall is an agent step written as an operator step.',
      path: ['steps'],
    },
  )
  .refine((entry) => entry.provesTask === undefined || entry.proves === 'rung', {
    message:
      'provesTask names the Academy rung that proves this account, so it only means something ' +
      'where proves is `rung`. An entry proved another way has no rung to point at.',
    path: ['provesTask'],
  })
  /**
   * **What the account is for comes after the account** (`#637`).
   *
   * The reach sequence starts from a proved account, so an entry that has not
   * said how the account is proved has nothing for it to start from. An entry
   * carrying one without a proof would be a recipe whose second half is reachable
   * and whose first half is not.
   */
  .refine((entry) => entry.reaches === undefined || entry.proves !== undefined, {
    message:
      'a reach starts from the account this recipe produces, so name how the account is proved ' +
      'first. Steps to a credential on an entry that never got as far as a proof are a second ' +
      'half with no first half.',
    path: ['reaches'],
  })
  /**
   * **One budget for both sequences**, because an agent walks one numbered list.
   * The bound is what a recipe is allowed to ask of a reader in total, and
   * splitting it in two would double it by writing the second half in a
   * different field.
   */
  .refine((entry) => entry.steps.length + (entry.reaches?.steps.length ?? 0) <= RECIPE_MAX_STEPS, {
    message:
      `a recipe and its reach share one budget of ${String(RECIPE_MAX_STEPS)} steps, because ` +
      'the agent walks one numbered list. Longer than that is a path nobody follows to the end.',
    path: ['reaches'],
  })
  /**
   * **The person belongs to the account and not to what follows it** (`#637`).
   *
   * Two surfaces make this a rule rather than a preference. `operatorNeed`, the
   * *how much of your operator* line and the takeover rule all read `steps`, so
   * a wall in the reach sequence would be one no page renders — a person
   * required at a step the entry says nobody is required at. And a handoff or a
   * handover resolves its step as `steps[position - 1]`, so an operator step
   * numbered past the account's would be one the agent is told to open and the
   * Colony cannot find.
   *
   * A reach that genuinely stops at a person is a recipe of its own.
   */
  .refine((entry) => (entry.reaches?.steps ?? []).every((step) => step.actor === 'agent'), {
    message:
      'a reach step is walked by the agent. Every surface that reads a person out of a recipe ' +
      'reads the account steps, so an operator step here is one nothing renders and nothing can ' +
      'open — a reach that stops at a person is its own recipe.',
    path: ['reaches', 'steps'],
  })
  /**
   * **A reach step is never wordless** (`#1032`).
   *
   * The account's own steps allow a wordless `agent` step, because a walk records
   * that a step happened and observes no sentence for it. Nothing derives a reach:
   * every reach sequence in the Colony was written by somebody who had the words
   * in hand, so an absent instruction here is a field left blank rather than an
   * honest record of what was seen. `retired` is exempt on the general rule that a
   * withdrawn entry keeps whatever it had.
   */
  .refine(
    (entry) =>
      entry.status === 'retired' ||
      (entry.reaches?.steps ?? []).every((step) => step.instruction !== undefined),
    {
      message:
        'every reach step needs to say what is done. Nothing derives a reach from a walk, so a ' +
        'blank one is a field left empty rather than something nobody observed.',
      path: ['reaches', 'steps'],
    },
  )
  /**
   * A refusal says why, a working entry says how, and an unwritten one says
   * neither. No state may be half of another: a refusal with no reason is a dead
   * end a reader cannot act on, a joinable entry with no steps claims to be a
   * recipe and is not, and an unwritten one carrying either is a half-written
   * recipe wearing the honest label.
   *
   * The same table as `recipeStatusAllowsSteps`, asserted field by field.
   */
  /**
   * **Every value an ask names is produced by an earlier step** (`#595`).
   *
   * The check that makes the reference safe rather than hopeful. An ask
   * referring to `{handle}` that nothing produces would be published as a
   * sentence with a brace in it, and the operator would read the literal text —
   * which is the same class of failure as the instruction arriving before its
   * values, one step further along.
   *
   * **Earlier, not anywhere**, because a value produced after the step that
   * consumes it cannot have been supplied when the handoff opens. The order the
   * steps are written in is the order they happen in, which is the whole reason
   * `RecipeActor` is a field on a step rather than a column on the entry.
   */
  .superRefine((entry, ctx) => {
    const produced = new Set<string>()

    const check = (step: RecipeStep, path: readonly (string | number)[]): void => {
      for (const missing of valuesReferencedBy(step.ask ?? '')) {
        if (produced.has(missing)) continue

        ctx.addIssue({
          code: 'custom',
          path: [...path],
          message:
            `this ask refers to {${missing}} and no earlier step produces it. Add it to the ` +
            '`produces` of the agent step that decides it, or the operator reads a brace.',
        })
      }

      for (const name of step.produces ?? []) produced.add(name)
    }

    entry.steps.forEach((step, index) => {
      check(step, ['steps', index, 'ask'])
    })
    /**
     * The reach sequence runs after the account's steps, so it may refer back to
     * what they produced and nothing may refer forward into it (`#637`).
     */
    entry.reaches?.steps.forEach((step, index) => {
      check(step, ['reaches', 'steps', index, 'ask'])
    })
  })
  .refine((entry) => entry.status !== 'refused' || entry.refusal !== undefined, {
    message: 'an entry that says a provider cannot be joined has to say why.',
    path: ['refusal'],
  })
  .refine((entry) => entry.status === 'refused' || entry.refusal === undefined, {
    message:
      'only a refused entry carries a refusal. An entry nobody has written up yet is unwritten, ' +
      'which says nobody has looked rather than that there is no way through; one that was ' +
      'withdrawn is retired, and carries a retiredReason instead.',
    path: ['refusal'],
  })
  /**
   * A direction only means something on a kind that has one (`#976`).
   *
   * The refusal is at the door rather than a silent drop, because a caller that
   * scoped a mailbox entry to `inbound` believed it had said something and would
   * otherwise find out by reading a shelf that ignored it.
   */
  .refine((entry) => entry.direction === undefined || kindHasDirection(entry.kind), {
    message:
      'only a kind whose verdicts have a direction carries one, and today that is phone: a number ' +
      'that can receive is a different account from one a carrier will let you send from. Leave it ' +
      'off everywhere else.',
    path: ['direction'],
  })
  /**
   * A caution is scoped only where a verdict could be (`#1041`).
   *
   * The same rule as `direction` above and refused at the same door: an entry
   * whose kind has no axis has one capability, so a caution scoped to half of it
   * is a warning the shelf would silently ignore. The unscoped caution is the
   * one every other kind writes, and it is not affected.
   */
  .refine(
    (entry) =>
      entry.cautions.every((one) => one.direction === null) || kindHasDirection(entry.kind),
    {
      message:
        'only a kind whose verdicts have a direction carries cautions scoped to one, and today ' +
        'that is phone. Everywhere else a caution warns whoever reads the entry, so leave its ' +
        'direction null.',
      path: ['cautions'],
    },
  )
  /**
   * A withdrawal says when and why, and nothing else may say why it was
   * withdrawn (`#604`).
   *
   * The pair is the same shape as `refused`/`refusal` one state along, and for
   * the same reason: a state whose explanation is optional is one that arrives
   * without one on the row nobody reviewed.
   */
  .refine((entry) => entry.status !== 'retired' || entry.retiredReason !== undefined, {
    message:
      'a withdrawn entry has to say why it was withdrawn. Its page stays up — a refusal is a ' +
      'page and not an omission, and so is a withdrawal — and the reason is the whole of what ' +
      'that page is for.',
    path: ['retiredReason'],
  })
  .refine((entry) => entry.status === 'retired' || entry.retiredReason === undefined, {
    message: 'only a withdrawn entry carries a withdrawal reason.',
    path: ['retiredReason'],
  })
  /**
   * **Steps belong to the states that have a walk behind them** (`#604`).
   *
   * `retired` is not listed in either direction — it keeps whatever it had.
   */
  .refine((entry) => entry.status !== 'joinable' || entry.steps.length > 0, {
    message:
      'a joinable provider needs at least one step. That is what makes it a recipe, and an ' +
      'entry with none is an unwritten entry with a busier label.',
    path: ['steps'],
  })
  .refine((entry) => recipeStatusAllowsSteps(entry.status) || entry.steps.length === 0, {
    message:
      'an entry in this state has nothing to walk. A partial recipe is one that fails at ' +
      'step three — say the steps when a walk has produced them, and nothing before that.',
    path: ['steps'],
  })
  /**
   * **An agent step may be wordless, and an operator step may not** (`#1032`).
   *
   * `#601` allowed a wordless step only on a `draft`, on the argument that
   * publishing was a steward supplying what the walk could not observe. `#1032`
   * retired the steward, so that sentence now has no author — and inventing one
   * is the thing `#517` forbids. What replaced it is the entry's computed
   * briefing: the walker's own account of the step, moderated as prose and
   * attributed, is what a reader follows, and {@link walkerShape} is explicit
   * that what the entry takes from a walk is the **shape** and not the wording.
   *
   * **The narrowing is to the actor, because that is where the old rule was
   * actually load-bearing.** An operator step carries the exact sentence a
   * person reads and the Colony writes it; a blank one would be a human handed
   * an empty instruction. An agent step with no sentence is a walk saying *a
   * step happened here and I acted alone*, which is true, useful and the most a
   * walk ever observed. `walkerShape` refuses to seed an operator step at all
   * for the same reason, so a walk-derived entry reaches this with agent steps
   * only.
   */
  .refine(
    (entry) =>
      entry.status === 'retired' ||
      entry.steps.every((step) => step.actor !== 'operator' || step.instruction !== undefined),
    {
      message:
        'an operator step needs to say what is done. The person reading it is not the agent ' +
        'that walked this, and a blank line is not an instruction. An agent step may be ' +
        'wordless — that is a walk recording its own shape, and the walker’s account carries ' +
        'the words.',
      path: ['steps'],
    },
  )
  .refine((entry) => entry.status !== 'joinable' || entry.proves !== undefined, {
    message:
      'name how the account is proved once it exists — a rung, or one of the generic proofs ' +
      'from #520. An entry that ends at a created account has stopped one step early. A walk ' +
      'that did not work out how to prove the account leaves the entry measured, and its own ' +
      'account of the signup is published in the briefing either way.',
    path: ['proves'],
  })
  /**
   * `proves` is forbidden where there is no walk behind the entry.
   */
  .refine(
    (entry) =>
      entry.status === 'joinable' || entry.status === 'retired' || entry.proves === undefined,
    {
      message: 'there is nothing to prove where there is nothing to walk.',
      path: ['proves'],
    },
  )
  /**
   * **A guess and a walk cannot disagree, because the guess is refused where
   * there is a walk** (`#589`). An entry with steps already answers this
   * question, in the only place the answer can be checked against.
   */
  .refine((entry) => entry.operatorGuess === undefined || entry.steps.length === 0, {
    message:
      'an entry with steps already says who has to be there — the operator steps are the answer, ' +
      'and a guess beside them is a second record of one fact that can go stale. Guess only ' +
      'where nobody has walked it.',
    path: ['operatorGuess'],
  })
export type WriteProviderRecipe = z.infer<typeof WriteProviderRecipeSchema>

/**
 * How long an entry stands before it is shown as a guess with a date on it
 * (`#525`).
 *
 * **A wrong recipe is worse than no recipe**: it sends every subsequent agent
 * down a path that does not work, and it looks authoritative because the Colony
 * published it. Ninety days because a signup form is changed on nobody's
 * schedule and a shorter window would mark half the catalogue stale while it was
 * still true — the stale mark has to mean *nobody has checked* rather than
 * *nobody has checked lately*, or readers learn to ignore it.
 */
export const RECIPE_STALE_AFTER_DAYS = 90

/**
 * Whether an entry is old enough to be shown as a guess rather than as fact.
 *
 * **Derived from the date, never stored as a flag.** A `stale` column would have
 * to be swept by something on a schedule, and the day that job stops running the
 * catalogue silently claims to be current. A comparison cannot stop running.
 *
 * **Here rather than beside the quest that asks for a confirmation** (`#860`).
 * It measures `lastConfirmedAt`, which is a field of this schema, and the Atlas
 * needs it to say how healthy an entry is — an `account/` module reaching into
 * `task/` for the meaning of its own column is the import that says the
 * definition is in the wrong place.
 */
export function isStale(lastConfirmedAt: string | null, at: Date = new Date()): boolean {
  if (lastConfirmedAt === null) return true

  const confirmed = new Date(lastConfirmedAt).getTime()
  if (Number.isNaN(confirmed)) return true

  return at.getTime() - confirmed > RECIPE_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000
}

/**
 * What a page says about an entry nobody has confirmed recently.
 *
 * One sentence, and it says *unconfirmed* rather than *wrong*: the recipe may
 * well still work, and a reader that treats staleness as a refusal will skip
 * providers that are perfectly joinable.
 */
export const STALE_ENTRY_NOTE =
  'Nobody has confirmed this recipe recently, so treat it as a guess with a date on it rather ' +
  'than as current. If you walk it, kolonie.accounts.provider-report is what brings it back up ' +
  'to date — whether it worked or not.'
