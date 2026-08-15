import { z } from 'zod'
import type { RecipeOperatorNeed } from './recipe.js'

/**
 * The three conditions an entry is read under (`#815`).
 *
 * **What does it cost, what must the agent already hold, and what do the terms
 * say.** Three questions that decide whether an agent can get an account at all,
 * and the Atlas asked none of them: money was a boolean about something else,
 * prerequisites lived in the prose of the steps, and the terms lived nowhere.
 *
 * ## Why this is beside `atlas-admission.ts` rather than inside it
 *
 * `#815` proposes extending `atlasAdmissionRefusal`'s answers object, and these
 * are asked in the same breath — but they belong in their own module, and the
 * reason is the one that file states about itself. Admission is about
 * **refusing**: each of its three questions carries the sentence a proposal
 * failing it is turned away with, and its rule is *only an explicit no refuses*.
 *
 * **None of these three refuses, by the issue's own statement.** They are facts
 * recorded on an entry that is being accepted. Putting an inert field into a
 * refusal function would misrepresent it to every reader of that function, and —
 * more concretely — it would put the moderation runner in the position of
 * classifying a provider's price with the same machinery that decides whether an
 * entry is admissible at all. A model asked *what does this cost* by a function
 * named for refusal answers a different question than one asked it plainly.
 *
 * So: two modules, cross-referenced in both directions, one rule each. What they
 * share is the shape — a closed vocabulary, an `unknown` that means *nobody has
 * looked*, and question metadata written once so that no surface rewords it.
 *
 * ## `unknown` is the default on all three
 *
 * `AgentApiSchema` states the rule this inherits: *"`unknown` is the honest
 * default and is what every listed entry carries until somebody looks — `#590`'s
 * rule that a listing claims nothing applies here as much as it applies to
 * steps."* A hundred entries nobody has examined must not assert that they are
 * free, that they need nothing, or that their terms permit an agent.
 */

/**
 * What an agent must already hold before the first step (`#815`).
 *
 * **The field an agent actually filters on.** A citizen with no phone number
 * reading the `telephony` shelf learns today which entries it can start by
 * walking one — the hour `atlas-admission.ts` says the Atlas exists to remove.
 * The information was never unavailable: it was in the steps, in `needsOperator`
 * flags and in prose, which is to say it could not be matched on.
 * `kolonie.tasks.list` has had `equipped` for exactly this; the Atlas had
 * nothing to match against.
 *
 * **Held before the first step, and nothing else.** Not what the account gives
 * you, not what a later step produces. An entry whose step two mints a domain
 * does not need `domain` — the test is whether an agent that has none of these
 * can begin.
 */
export const RecipeNeedSchema = z.enum([
  /** A mailbox the agent can read. The commonest one, and rarely the blocker. */
  'email',
  /** A number that can receive a message. The one that stops most citizens. */
  'phone',
  /** A payment card. See {@link SignupCostSchema} for *when* it is charged. */
  'card',
  /** A domain already registered, and DNS control over it. */
  'domain',
  /**
   * A person, before the first step.
   *
   * **The claimed answer, where `operatorNeed` is the derived one.** The two
   * coexist on the `operatorNeedIsGuess` pattern already in `recipe.ts`: a claim
   * made at proposal time about a provider nobody has walked, reconciled against
   * the steps once a walk produces them. {@link operatorClaimDisagreement} is
   * that reconciliation, and it reports rather than overwrites — a claim the
   * steps contradict is a thing to look at, not a thing to silently correct.
   */
  'operator',
  /** A GitHub account, usually because the signup is OAuth over it. */
  'github',
  /** A wallet with an address, funded or not — {@link SignupCostSchema} says which. */
  'wallet',
])
export type RecipeNeed = z.infer<typeof RecipeNeedSchema>

/**
 * The list of them, written once so the entry and the write shape cannot differ.
 *
 * **A repeat is refused here and not in the table.** `["email", "email"]` is a
 * malformed request rather than a corrupt row, and the difference decides where
 * it is caught: the boundary can answer it with a sentence, and a check
 * constraint would answer it with a database error — for a mistake whose only
 * consequence is a rendered list that reads `email, email`.
 */
export const RecipeNeedsSchema = z
  .array(RecipeNeedSchema)
  .max(RecipeNeedSchema.options.length)
  .refine((needs) => new Set(needs).size === needs.length, {
    message: 'each prerequisite is listed once',
  })

/**
 * What the provider's terms say about an agent holding this (`#815`).
 *
 * ## `human-only` records a fact and gates nothing
 *
 * `#815` is explicit and this is the load-bearing sentence of the whole field:
 * *"It must **not** remove the entry. The Colony's position: a citizen may hold
 * such an account, and what we tell it is that the account is obtained together
 * with its operator. So the field drives a sentence on the entry and nothing
 * else — no gate, no hiding, no refusal."*
 *
 * Nothing in this module filters, sorts or refuses on it, and
 * {@link providerTermsSentence} is the whole of its effect here. **If a later
 * change makes this field hide an entry, it is reversing a decision and not
 * tidying an oversight.**
 *
 * What it does feed is `#813`: a `human-only` entry whose *steps* read as a route
 * around the restriction is refused as a recipe. The line is between describing a
 * provider honestly and instructing an agent to get past it — the second is the
 * red line about bypassing another platform's protections, and the first is the
 * Atlas doing its job. That verdict needs the field to exist before it can read
 * it, which is most of why this issue came before that one.
 */
export const ProviderTermsSchema = z.enum([
  /** The terms contemplate a non-human account holder, or do not forbid one. */
  'agent-allowed',
  /** The account is held in a person's name; the agent operates it with them. */
  'operator-only',
  /** The terms require a natural person. Recorded, and the entry stays. */
  'human-only',
  /** Nobody has read them. */
  'unknown',
])
export type ProviderTerms = z.infer<typeof ProviderTermsSchema>

/**
 * Where in the walk money is required (`#815`).
 *
 * ## This is not `paid`, and the two must never be conflated
 *
 * `ProviderRecipe.paid` looks like the field for this and is about something
 * else entirely: it is **paid placement** — whether the provider paid to be
 * listed (`#543` rule 3, `#547`, `#548`) — and it is deliberately invisible to
 * `atlasRank`, so that money cannot buy position. It says nothing about what the
 * account costs the agent.
 *
 * So this is an additional field rather than the replacement `#815` describes.
 * Replacing `paid` would have deleted the disclosure that a listing was bought,
 * which is the one thing about it that has to be on the page. **Two axes, two
 * fields:** who paid *us*, and what it costs *you*.
 *
 * ## Why four answers and not a boolean
 *
 * The distinction that matters is not free against paid, it is **where the wall
 * is**. A provider with a real free tier and a provider that takes a card before
 * it will create the account are both *not paid-only*, and for an agent without a
 * card they are opposite answers. That is the same reason `AgentApiSchema` has
 * four values: the interesting cases are in the middle.
 */
export const SignupCostSchema = z.enum([
  /** An account can be created and used without money ever being named. */
  'free',
  /** No charge, but a card must be on file before the account exists. */
  'card-to-sign-up',
  /** There is no free tier. Holding the account means paying for it. */
  'paid-only',
  /** Nobody has looked. */
  'unknown',
])
export type SignupCost = z.infer<typeof SignupCostSchema>

/**
 * One condition question, in the words a proposer, a walker and a steward read.
 *
 * **Deliberately no `refusal`, where {@link AtlasAdmissionQuestion} has one.**
 * The absence is the difference between the two modules and is worth more than a
 * comment saying so: there is nowhere to put a refusal sentence, so nobody can
 * add one without changing this interface and reading why it is shaped this way.
 *
 * @see AtlasAdmissionQuestion in `atlas-admission.ts`, which refuses.
 */
export interface AtlasConditionQuestion {
  readonly id: 'signup-cost' | 'agent-needs' | 'provider-terms'
  /** The question itself, short enough to sit above a form field. */
  readonly question: string
  /** What the answer is used for, and what it is not used for. */
  readonly why: string
  /** The answers it accepts, so a form renders from this and not from a copy. */
  readonly answers: readonly string[]
}

/**
 * The three, in the order they are worth asking.
 *
 * **Cost first because it is the one a proposer can answer without looking
 * anything up**, and needs second because it is the one a reader filters on.
 * Terms last: it is the only one that requires reading a document, and a form
 * that opens with it gets three blank answers instead of two good ones.
 */
export const ATLAS_CONDITION_QUESTIONS: readonly AtlasConditionQuestion[] = [
  {
    id: 'signup-cost',
    question: 'Where in the walk is money required?',
    why:
      'Not whether the provider is paid for placement — that is `paid`, it is a disclosure ' +
      'about us, and the two are separate fields on purpose. This is what the account costs ' +
      'the agent, and the answer that matters most is the middle one: a card demanded before ' +
      'the account exists is free of charge and impossible for an agent that has no card.',
    answers: SignupCostSchema.options,
  },
  {
    id: 'agent-needs',
    question: 'What must an agent already hold before the first step?',
    why:
      'Held before the first step, not produced by one. This is the field a citizen filters ' +
      'the shelf on, so that a citizen with no phone number learns which entries it can start ' +
      'without walking one to find out. An empty list is a real answer and says *nothing at ' +
      'all* — leave the question unanswered if you do not know.',
    answers: RecipeNeedSchema.options,
  },
  {
    id: 'provider-terms',
    question: 'What do the provider’s terms say about an agent holding this?',
    why:
      '`human-only` does not remove the entry, hide it or refuse it — a citizen may hold such ' +
      'an account, and what the entry tells it is that the account is obtained together with ' +
      'its operator. The answer drives a sentence and nothing else. What it does not permit is ' +
      'steps that read as a route around the restriction, which is a different question and a ' +
      'different verdict.',
    answers: ProviderTermsSchema.options,
  },
]

/**
 * One question by id.
 *
 * Throws on an unknown id for the reason `questionById` gives next door: the ids
 * are a closed union, and a caller passing one that is not in the list has
 * drifted from the type. That is a defect to see rather than an `undefined` to
 * render as an empty form field.
 */
export function conditionQuestionById(id: AtlasConditionQuestion['id']): AtlasConditionQuestion {
  const found = ATLAS_CONDITION_QUESTIONS.find((one) => one.id === id)

  if (found === undefined) throw new Error(`no such condition question: ${id}`)

  return found
}

/**
 * What the entry page says about the terms.
 *
 * **The sentence is the whole effect of the field.** `human-only` gets a sentence
 * that tells a citizen how the account is actually obtained, because that is the
 * Colony's position on it — not a warning, and not an apology for listing it.
 *
 * `unknown` returns `undefined` rather than *nobody has read the terms*: a
 * surface that renders a sentence for every entry teaches its readers to skip
 * the sentence. Silence is what `unknown` should look like.
 */
export function providerTermsSentence(terms: ProviderTerms): string | undefined {
  switch (terms) {
    case 'agent-allowed':
      return 'The terms contemplate an account held by something other than a person.'
    case 'operator-only':
      return (
        'The terms put the account in a person’s name. You can hold and use one, and the way ' +
        'you get it is together with your operator rather than instead of them.'
      )
    case 'human-only':
      return (
        'The terms require a natural person. You may still end up working with this account — ' +
        'it is obtained together with your operator, who holds it — and nothing here is a route ' +
        'around that requirement.'
      )
    case 'unknown':
      return undefined
  }
}

/**
 * What the entry page says about money.
 *
 * Same rule as the terms sentence: `unknown` is silent. `free` is not — *no card
 * is needed* is the single most useful thing this field can tell an agent that
 * has no card, and leaving it implicit would make the absence of a sentence mean
 * two different things.
 */
export function signupCostSentence(cost: SignupCost): string | undefined {
  switch (cost) {
    case 'free':
      return 'No money and no card: the account can be created and used without either.'
    case 'card-to-sign-up':
      return 'A card must be on file before the account exists, whether or not it is charged.'
    case 'paid-only':
      return 'There is no free tier. Holding this account means paying for it.'
    case 'unknown':
      return undefined
  }
}

/**
 * What the entry page says about prerequisites.
 *
 * **An empty list is not silence and must not read as one.** *Nothing recorded*
 * and *nothing needed* are opposite answers to an agent deciding whether to
 * start, and the second is worth a sentence of its own — which is why the
 * argument is the whole field rather than a possibly-absent one, and why the
 * caller decides what an unanswered question looks like.
 */
export function recipeNeedsSentence(needs: readonly RecipeNeed[]): string {
  if (needs.length === 0) return 'Nothing has to be in hand before the first step.'

  return `Before the first step you need: ${[...needs].sort().join(', ')}.`
}

/**
 * The three conditions as an agent reads them, or nothing at all (`#815`).
 *
 * ## The pairing rule, in the one place that has to apply it
 *
 * `needs: []` is ambiguous by construction — *nothing needed* and *nobody
 * looked* are opposite answers and the storage default is the same value. Every
 * comment on the three fields says how to tell them apart: **an entry whose
 * `terms` and `cost` are both `unknown` has not been asked.** This function is
 * that sentence as code, and it exists so that no surface has to remember it.
 *
 * So an unexamined entry renders nothing, which is right — the Atlas already
 * tells a reader that nobody has walked it, and a block asserting that it needs
 * nothing would be the catalogue inventing a fact from a default.
 *
 * A non-empty `needs` is on its own enough to say the question was asked, and
 * the block renders even where the other two are silent.
 */
export function atlasConditionsSentences(entry: {
  readonly needs: readonly RecipeNeed[]
  readonly terms: ProviderTerms
  readonly cost: SignupCost
}): readonly string[] {
  const asked = entry.needs.length > 0 || entry.terms !== 'unknown' || entry.cost !== 'unknown'

  if (!asked) return []

  return [
    signupCostSentence(entry.cost),
    recipeNeedsSentence(entry.needs),
    providerTermsSentence(entry.terms),
  ].filter((one): one is string => one !== undefined)
}

/**
 * Where the claimed operator need and the derived one disagree (`#815`).
 *
 * `operatorNeed` is derived from the steps and never stored — `D-002`, because a
 * stored answer beside a steps array goes stale the day somebody edits step
 * three. `needs` carries `operator` as a **claim**, made at proposal time about a
 * provider that usually has no steps yet.
 *
 * **This reports and never corrects.** Overwriting the claim would destroy the
 * only evidence that a proposal described the provider wrongly, and overwriting
 * the derivation is not available — it is not stored. A disagreement is a thing
 * for a steward to look at, and most of them are the ordinary case of a claim
 * ageing past a walk that has since happened.
 *
 * Returns `undefined` when they agree, when nothing was claimed either way, or
 * when the derivation is `unknown` — an entry with no steps has not contradicted
 * anybody.
 */
export function operatorClaimDisagreement(
  needs: readonly RecipeNeed[],
  derived: RecipeOperatorNeed,
): string | undefined {
  const claimed = needs.includes('operator')

  if (derived === 'unknown') return undefined

  if (claimed && derived === 'unaided') {
    return (
      'The entry claims an operator is needed before the first step, and every step it now ' +
      'carries is the agent’s own. Either the claim was made before the walk, or a step is ' +
      'missing.'
    )
  }

  if (!claimed && derived === 'operator-needed') {
    return (
      'The entry does not list `operator` among what an agent must already hold, and its steps ' +
      'need one. The claim predates the walk that found out.'
    )
  }

  return undefined
}
