import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { looksLikeCredential } from '../operator/request.js'
import { AgentPlatformSchema } from '../agent/agent.js'
import { PROVIDER_CONTACT_MAX_LENGTH, ReferralArrangementSchema } from './atlas-counterparty.js'
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
     * **Optional, and only a `draft` may leave it out** (`#601`). The rule is on
     * `WriteProviderRecipeSchema` and on the table's own check constraint rather
     * than here, because it is a fact about the entry's state and a step does not
     * know what state it is in.
     *
     * A walk writes a draft as a by-product of an agent obtaining an account, and
     * what a walk observes is *what happened* — an operator was asked here, the
     * agent acted alone there. It does not observe a sentence, and `#601` is
     * explicit that the Colony must not invent one:
     *
     * > The Colony still writes the operator's sentence (`#517`), so a draft
     * > carries the actions and a steward supplies the wording.
     *
     * That shape was not representable while this was required — a derived draft
     * would have had to carry a sentence nobody wrote, and a steward publishing
     * without rewriting would have shipped it. An absent instruction is the
     * honest record of *nobody has written this step up yet*, and it cannot reach
     * a reader: no public surface renders a draft (`#604`), and no entry can
     * leave `draft` while a step is still wordless.
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
  })
  .strict()
  .refine((step) => step.actor === 'agent' || step.produces === undefined, {
    message:
      'only an agent step produces values. What an operator step produces is the operator’s ' +
      'answer, and that already has a channel.',
    path: ['produces'],
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

/** How long a refusal reason may be. */
export const RECIPE_REFUSAL_MAX_LENGTH = 500

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
 * | `proposed` | somebody asked for this provider and nobody has decided whether it belongs |
 * | `unwritten` | on the map, nobody has looked |
 * | `draft` | a walk produced steps that no steward has approved |
 * | `joinable` | steps exist, `proves` is set, and the Colony stands behind it |
 * | `refused` | walked, no honest route, reason required |
 * | `retired` | deliberately withdrawn, keeping its steps and saying why |
 *
 * **The order is the life and not an alphabet**, and it is load-bearing in one
 * place: `RECIPE_STATUSES` reaches the table's check constraint in this order,
 * so a `psql` prompt reading the constraint reads the sequence.
 *
 * **`joinable` was not renamed to `published`**, which would be tidier and would
 * touch every surface that shipped on 2026-08-08 for no behaviour change. `#604`
 * refused the churn explicitly; this note is here so nobody rediscovers the
 * argument.
 *
 * Two properties every surface needs and neither of which is inferable from the
 * name: `recipeStatusIsPublic` decides whether a stranger may see the entry at
 * all, and `recipeStatusIsOfferable` decides whether an agent may be sent to
 * walk it. A surface that has not been told renders a `draft` as joinable, which
 * is an agent following a recipe nobody approved.
 */
export const RecipeStatusSchema = z.enum([
  'proposed',
  'unwritten',
  'draft',
  'joinable',
  'refused',
  'retired',
])
export type RecipeStatus = z.infer<typeof RecipeStatusSchema>

/**
 * Whether a stranger may see this entry at all (`#604`).
 *
 * **Two of the six are internal and the reasons are different.** A `proposed`
 * entry is *somebody else's suggestion* — publishing it would put a claim about
 * a third party's product on `kolonie.ai` before anybody at the Colony had read
 * it. A `draft` is the Colony's own work in progress, and publishing it would
 * offer an agent a path no steward has stood behind.
 *
 * **`retired` is public and that is the point of it.** `growth/README.md`'s
 * standing rule is that *a refusal is a page, not an omission*; a withdrawal is
 * the same class of fact. The alternative — deleting the row — destroys the
 * record of why the Colony ever recommended it, which is exactly what a reader
 * arriving from an old link needs.
 */
export function recipeStatusIsPublic(status: RecipeStatus): boolean {
  return status !== 'proposed' && status !== 'draft'
}

/**
 * Whether an agent may be sent to walk this entry (`#604`).
 *
 * One state, and it is deliberately narrower than `recipeStatusIsPublic`: a
 * retired entry has a page a reader can still open and is not on offer, and a
 * draft is neither. `handoffStep` in the API refuses everything else *by name*,
 * because *nobody has walked this yet*, *this is waiting for review* and *this
 * was withdrawn* are three different answers and an agent can act on each.
 */
export function recipeStatusIsOfferable(status: RecipeStatus): boolean {
  return status === 'joinable'
}

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
 * What an entry in each state may carry.
 *
 * Stated once, here, and asserted by `WriteProviderRecipeSchema`, by
 * `CatalogueDeliverableSchema` and by the table's own check constraints — three
 * boundaries reading one table rather than three prose paraphrases that drift.
 *
 * | `status` | steps | `proves` | `refusal` | `retiredAt` |
 * |---|---|---|---|---|
 * | `proposed` | 0 | forbidden | forbidden | null |
 * | `unwritten` | 0 | forbidden | forbidden | null |
 * | `draft` | 1–20 | optional | forbidden | null |
 * | `joinable` | 1–20 | required | forbidden | null |
 * | `refused` | 0 | forbidden | required | null |
 * | `retired` | any | any | any | required, with a reason |
 *
 * **What an unwritten entry carries instead is what `#589` adds** — the provider,
 * its category, and whether an agent can walk it alone. Never half-written steps:
 * a partial recipe is one that fails at step three, and the whole design is that
 * the Colony wrote the path.
 *
 * **`draft` is the one state where that rule is suspended, and only because
 * nobody is offered it** (`#604`). A walk that produced four steps and no
 * `proves` is exactly what a steward has to be able to look at; refusing to
 * store it would mean the walk's output lived in a GitHub issue, which is the
 * defect `#601` is named for. It carries steps and is not public, and the two
 * facts are the same decision.
 *
 * **`retired` constrains nothing, deliberately.** It is a *former* state of any
 * of the others and keeps whatever it had — an entry withdrawn while joinable
 * keeps its steps and its `proves`, one withdrawn while refused keeps its
 * reason. Re-checking the old shape at withdrawal time would mean a row could
 * become unretireable because of a rule written after it, and a withdrawal that
 * can fail is one somebody works around by deleting the row.
 */
export function recipeStatusAllowsSteps(status: RecipeStatus): boolean {
  return status === 'joinable' || status === 'draft' || status === 'retired'
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
 * What a page says about an entry a steward has not published (`#604`).
 *
 * **A draft has no public page, so this is not read by a stranger** — it is what
 * the console's curation queue and `/backend` say about the row. The note exists
 * anyway, and beside the other two, because the three are read together and a
 * state whose sentence lives inline in one surface is a state the next surface
 * describes differently.
 *
 * The tone is neither the apology `unwritten` avoids nor the warning `refused`
 * carries: a draft is work that happened, waiting on one person.
 */
export const DRAFT_ENTRY_NOTE =
  'Somebody walked this and wrote down what they found, and no steward has published it yet. ' +
  'The steps below are what the walk produced — they are not the Colony saying this path works, ' +
  'which is what publishing means and is why an agent is not offered a draft. Reviewing it is ' +
  'the only thing between here and a recipe.'

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
   * Two of the six never reach a stranger — see `recipeStatusIsPublic` — and one
   * of the six is what an agent may be sent to walk. Neither is inferable from
   * the name, so no surface should branch on the string.
   */
  status: RecipeStatusSchema,
  /** Why not, when the status is `refused`. Null otherwise. */
  refusal: z.string().max(RECIPE_REFUSAL_MAX_LENGTH).nullable(),
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
   * Empty on `proposed`, `unwritten` and `refused`, because there is nothing to
   * walk. Present on `joinable` and on `draft`, and kept on `retired` — see
   * `recipeStatusAllowsSteps`, which is the one implementation of that table.
   */
  steps: z.array(RecipeStepSchema).max(RECIPE_MAX_STEPS),
  /**
   * How the account is proved once it exists.
   *
   * `rung` means an Academy verifier does it and the recipe points at the rung;
   * the other two are `#520`'s generic proofs. Required on `joinable`, optional
   * on `draft` — a walk that got an account and did not work out how to prove it
   * is a real and reviewable outcome — and forbidden where there is nothing to
   * walk. `retired` keeps whatever it had.
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
    caution: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
    /** Stricter than the default, when `provider-report` findings say so (`#532`). */
    pacePerDay: z.int().min(1).max(RECIPE_MAX_PACE_PER_DAY).optional(),
  })
  .strict()
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

    entry.steps.forEach((step, index) => {
      for (const missing of valuesReferencedBy(step.ask ?? '')) {
        if (produced.has(missing)) continue

        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'ask'],
          message:
            `this ask refers to {${missing}} and no earlier step produces it. Add it to the ` +
            '`produces` of the agent step that decides it, or the operator reads a brace.',
        })
      }

      for (const name of step.produces ?? []) produced.add(name)
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
   * `draft` joins `joinable` here, which is the one place `#588`'s *nothing but
   * joinable carries steps* rule was loosened. It is safe precisely because a
   * draft reaches no public surface: the steps are what a steward reviews, and
   * refusing to store them would put the output of a walk in a GitHub issue,
   * which is the defect `#601` exists for.
   *
   * `retired` is not listed in either direction — it keeps whatever it had.
   */
  .refine(
    (entry) => !(entry.status === 'joinable' || entry.status === 'draft') || entry.steps.length > 0,
    {
      message:
        'a joinable or draft provider needs at least one step. That is what makes it a recipe, ' +
        'and a draft with no steps is an unwritten entry with a busier label.',
      path: ['steps'],
    },
  )
  .refine((entry) => recipeStatusAllowsSteps(entry.status) || entry.steps.length === 0, {
    message:
      'an entry in this state has nothing to walk. A partial recipe is one that fails at ' +
      'step three — say the steps when a walk has produced them, as a draft if nobody has ' +
      'reviewed it yet, and nothing before that.',
    path: ['steps'],
  })
  /**
   * **A step may be wordless only while the entry is a draft** (`#601`).
   *
   * This is the other half of making `instruction` optional, and it is the half
   * that matters: a draft is the one state a walk can write, and publishing is
   * exactly the act of a steward having supplied what the walk could not
   * observe. An entry that left `draft` with a wordless step would be a recipe
   * with a blank line in it, handed to an agent as a path to follow.
   *
   * `retired` is allowed one, because it keeps whatever it had — an entry
   * withdrawn while it was still a draft keeps the record of the walk, which is
   * the whole argument for `retired` in `#604`.
   */
  .refine(
    (entry) =>
      entry.status === 'draft' ||
      entry.status === 'retired' ||
      entry.steps.every((step) => step.instruction !== undefined),
    {
      message:
        'every step needs to say what is done before the entry leaves draft. A walk records ' +
        'that a step happened and who it needed; the sentence is a steward’s, and publishing ' +
        'is where it gets written.',
      path: ['steps'],
    },
  )
  .refine((entry) => entry.status !== 'joinable' || entry.proves !== undefined, {
    message:
      'name how the account is proved once it exists — a rung, or one of the generic proofs ' +
      'from #520. An entry that ends at a created account has stopped one step early. A walk ' +
      'that did not work out how to prove the account is a draft rather than a joinable entry.',
    path: ['proves'],
  })
  /**
   * `proves` is optional on a draft and forbidden where there is no walk. A walk
   * that got an account and did not establish the proof is a real outcome and a
   * reviewable one; refusing to store it loses the walk.
   */
  .refine(
    (entry) =>
      entry.status === 'joinable' ||
      entry.status === 'draft' ||
      entry.status === 'retired' ||
      entry.proves === undefined,
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
