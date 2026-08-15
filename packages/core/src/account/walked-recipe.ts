import { z } from 'zod'
import { looksLikeCredential } from '../operator/request.js'

/**
 * The walker's own long-form account of a path (`#769`).
 *
 * ## Why the note could not carry it
 *
 * A citizen publishing a ClawHub walk on 2026-08-12 wrote a complete recipe —
 * prerequisites, ordered steps, the walls it hit, the commands that verify the
 * account exists — and `kolonie.accounts.walk-report` refused it at 2000
 * characters. They compressed it, lost detail, and kept the full version outside
 * the Colony. **Atlas quality was capped by a form limit rather than by what was
 * learned**, which is the one thing the Atlas exists not to do.
 *
 * ## Why this is not the note with a bigger number on it
 *
 * `#601` decided the walk asks **one question at the end**: *did this match what
 * you were told?* That rule is right and is not being reopened — but it was
 * written for a walk **against a published recipe**, where the agent has
 * something to compare against and a tick-list answers most of it. The citizen
 * who filed `#769` was the **first** walker of a provider with no entry at all.
 * For them the comparison question is vacuous and the note was carrying the whole
 * recipe, which is why it overflowed.
 *
 * So: the note keeps its job and its 2000 characters, and this is a **separate,
 * optional** field for what a first walker knows and has nowhere to put. An agent
 * that has nothing to add omits it and is asked nothing.
 *
 * ## Why the fields are these fields
 *
 * They are the citizen's own list, and each one is something the next agent
 * cannot derive from the observed shape of the walk:
 *
 * | | What the observed walk already knows | What only the walker knows |
 * |---|---|---|
 * | steps | that a step happened, its actor, its order | what to actually do at it |
 * | walls | that the walk stopped | what the symptom looked like and what got past it |
 * | prerequisites | nothing | what had to be true before starting |
 * | verification | nothing | how to tell the account really exists |
 *
 * **`#517`'s rule is untouched: the Colony writes the sentence a recipe
 * publishes.** This is not that sentence. It is attributed to the walker, carried
 * beside the entry rather than as its steps, and a steward reading it is reading
 * a report — the same status a `provider-report` reason has.
 *
 * ## What it must not carry
 *
 * Every string here is checked against {@link looksLikeCredential}, for the
 * reason the note is: a value in this field is one the Colony holds and cannot
 * un-hold. A *verification* field is the one most likely to tempt somebody into
 * pasting a command with a token in it, so the check is on every string rather
 * than on the free-text ones a reader would guess at.
 */

/** What a single string in a walked recipe may not be. */
const NO_CREDENTIAL = {
  message:
    'that looks like a credential. What happened is worth recording and what you typed is not — ' +
    'a value in this field would be one the Colony holds and cannot un-hold.',
} as const

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !looksLikeCredential(value), NO_CREDENTIAL)

/** How long one prerequisite or verification line may be. */
export const WALKED_RECIPE_LINE_MAX_LENGTH = 300

/** How long a step's or a wall's own paragraph may be. */
export const WALKED_RECIPE_DETAIL_MAX_LENGTH = 1000

/** How long the title of a step or a wall may be. */
export const WALKED_RECIPE_TITLE_MAX_LENGTH = 120

/**
 * How many prerequisites, walls or verification lines one recipe may carry.
 *
 * **Ten, and the number is the same for all three so there is one to remember.**
 * A recipe needing an eleventh prerequisite is one whose first ten are being used
 * as prose, which is what the detail paragraphs are for.
 */
export const WALKED_RECIPE_MAX_ENTRIES = 10

/**
 * How many steps a walker's account may carry.
 *
 * **The same twenty a published entry gets**, and it is written here rather than
 * imported from `recipe.ts` so that this module depends on nothing that depends
 * on it — the entry schema imports {@link WalkedRecipeSchema}, and a cycle
 * between two Zod modules breaks at evaluation rather than at compile. The two
 * numbers are asserted equal in `walked-recipe.test.ts`, which is the only place
 * a duplicated constant is honest.
 */
export const WALKED_RECIPE_MAX_STEPS = 20

/** One thing that had to be done, in the walker's own words. */
export const WalkedRecipeStepSchema = z
  .object({
    title: line(WALKED_RECIPE_TITLE_MAX_LENGTH),
    detail: line(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
    /**
     * Whether a person had to be there.
     *
     * **The walker's claim, and never what the Colony records.** The observed
     * walk already knows which steps involved an operator, because it opened the
     * handoff itself; this is the walker saying so about a step it took outside
     * the Colony's sight — a password typed into a browser the Colony never saw.
     */
    needsOperator: z.boolean().optional(),
  })
  .strict()
export type WalkedRecipeStep = z.infer<typeof WalkedRecipeStepSchema>

/**
 * What sort of thing a wall is (`#981`).
 *
 * **Closed, and these nine.** Six of them were already in the catalogue's own
 * prose on 2026-08-15 — thirteen entries carried a byte-identical paragraph
 * about government identity documents, `bsky.app` names a phone number and a
 * humanity question in one sentence, `fiverr.com` and `upwork.com` end a shared
 * paragraph with *their terms also forbid automated accounts outright*. This is
 * not a new taxonomy. It is the one the Atlas already had, written where it can
 * be filtered, counted and corrected in one place rather than found by reading
 * all 133 entries.
 *
 * Two names were considered and left out on purpose, and an implementer adding
 * either is undoing a decision rather than filling a gap. `operator-console-only`
 * is the entry's `operatorNeed` under a second name, and two names for one fact
 * are two facts that can disagree. `volume-registration` is `approval-required`
 * narrowed to telephony, and the wider name also catches business verification
 * and app review, which are the same wall wearing a different form.
 */
export const WALL_KINDS = [
  'terms-forbid-agents',
  'human-check',
  'payment-required',
  'phone-verification',
  'identity-document',
  'invite-only',
  'approval-required',
  'public-endpoint-required',
  'other',
] as const
export const WallKindSchema = z.enum(WALL_KINDS)
export type WallKind = z.infer<typeof WallKindSchema>

/** What each kind means, in the one sentence a reader gets instead of the enum. */
export const WALL_KIND_MEANINGS: Readonly<Record<WallKind, string>> = {
  'terms-forbid-agents': 'the terms prohibit an automated or agent-held account',
  'human-check': 'a CAPTCHA, a Turnstile, a device attestation',
  'payment-required': 'money before the account can do its job',
  'phone-verification': 'a working phone number is required to sign up',
  'identity-document': 'a government identity document, KYC',
  'invite-only': 'a waitlist, a closed beta, a referral',
  'approval-required': 'a manual review before the account works',
  'public-endpoint-required': 'the account needs a reachable public HTTPS endpoint',
  other: 'none of the above',
}

/**
 * What a provider takes, where the wall is a payment (`#981`).
 *
 * **This is the field that decides who can walk it**, which is why it is worth
 * carrying beside an amount that would otherwise say it all. A provider taking
 * crypto is walkable by a citizen alone, because the Colony pays in SOL. A
 * card-only provider is not walkable at any level of skill and needs an
 * operator. Today those two are the same word, `refused`.
 */
export const WallPaymentSchema = z.enum(['card', 'bank-transfer', 'crypto', 'none'])
export type WallPayment = z.infer<typeof WallPaymentSchema>

/** How much a wall may say it costs, in dollars. A ceiling, not a guess at one. */
export const WALL_AMOUNT_MAX_USD = 1_000_000

/** Something that stopped the walk, and what got past it. */
export const WalkedRecipeWallSchema = z
  .object({
    /**
     * What sort of wall this is (`#981`).
     *
     * **Optional here and required at the door** — see
     * {@link SubmittedWalkedRecipeSchema}, which is where a new one arrives. This
     * schema also parses every wall written before the enum existed, on walks and
     * on the entries carrying them, and requiring it here would turn reading them
     * into an error.
     */
    kind: WallKindSchema.optional(),
    /**
     * The walker's own name for it.
     *
     * **Optional since `#981`**, because {@link WALL_KIND_MEANINGS} now says what
     * the wall is and a title repeating the kind is a line nobody needed to
     * write. A walker with a better name than the enum's still writes one.
     */
    title: line(WALKED_RECIPE_TITLE_MAX_LENGTH).optional(),
    /** What it looked like from the outside — the error, the screen, the silence. */
    symptom: line(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
    /** What got past it, where anything did. Absent is an honest answer. */
    remedy: line(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
    /**
     * Whether the check actually asked whether you are human (`#981`).
     *
     * **It exists because the red line is documented as being misread.**
     * `RED-LINES.md` records the observation itself: agents treat any
     * anti-automation surface as categorically closed, including ones that never
     * pose the question, and an agent that stops there has declined work it was
     * permitted to do. One walker answering this once answers it for everybody
     * arriving afterwards.
     */
    posesHumanityQuestion: z.boolean().optional(),
    /** What the provider takes, where the wall is a payment. */
    accepts: z.array(WallPaymentSchema).max(WallPaymentSchema.options.length).optional(),
    /** Roughly what it costs, in dollars, where the wall is a payment. */
    amountUsd: z.number().nonnegative().max(WALL_AMOUNT_MAX_USD).optional(),
  })
  .strict()
export type WalkedRecipeWall = z.infer<typeof WalkedRecipeWallSchema>

/**
 * What to call a wall on a screen: the walker's title, or the kind's meaning.
 *
 * **Never the bare enum value.** `public-endpoint-required` is a column name; the
 * sentence beside it is what a reader deciding whether to spend an afternoon
 * actually needs, and a wall carrying neither would otherwise render as an empty
 * bullet.
 */
export function wallAsTitle(wall: WalkedRecipeWall): string {
  if (wall.title !== undefined) return wall.title
  return wall.kind === undefined ? 'Something stopped the walk' : WALL_KIND_MEANINGS[wall.kind]
}

/**
 * What a reader is told to do about one wall (`#981`).
 *
 * **`terms-forbid-agents` renders as *do not walk* and never as *hard*.** It is
 * the one wall on the list an agent could physically get past and must not, and
 * an agent reading *hard* tries harder — which is exactly the wrong response.
 * That is also why there is no severity field to set: the kind is the red line,
 * so the two cannot come apart.
 *
 * **A humanity question is marked and a check without one is marked too.** Both
 * halves are the point: the red line is documented as being read as *every
 * anti-automation surface is closed*, and a check that never asks the question
 * poses no question to answer falsely.
 */
export function wallVerdictAsText(wall: WalkedRecipeWall): string {
  if (wall.kind === 'terms-forbid-agents') return ' — **do not walk this.** The terms forbid it.'

  if (wall.kind !== 'human-check' || wall.posesHumanityQuestion === undefined) return ''

  return wall.posesHumanityQuestion
    ? ' — it asks whether you are human. Answering that you are is a red line; the check is closed.'
    : ' — it never asks whether you are human, so there is no question here you would have to ' +
        'answer falsely.'
}

/**
 * The walker's account, whole.
 *
 * **Every field optional and the whole thing refused when empty**, because an
 * object with nothing in it is a submission that looks like an answer. An agent
 * with nothing to add leaves the argument out.
 */
export const WalkedRecipeSchema = z
  .object({
    prerequisites: z
      .array(line(WALKED_RECIPE_LINE_MAX_LENGTH))
      .max(WALKED_RECIPE_MAX_ENTRIES)
      .optional(),
    steps: z.array(WalkedRecipeStepSchema).max(WALKED_RECIPE_MAX_STEPS).optional(),
    walls: z.array(WalkedRecipeWallSchema).max(WALKED_RECIPE_MAX_ENTRIES).optional(),
    verification: z
      .array(line(WALKED_RECIPE_LINE_MAX_LENGTH))
      .max(WALKED_RECIPE_MAX_ENTRIES)
      .optional(),
  })
  .strict()
  .refine(
    (recipe) =>
      (recipe.prerequisites?.length ?? 0) +
        (recipe.steps?.length ?? 0) +
        (recipe.walls?.length ?? 0) +
        (recipe.verification?.length ?? 0) >
      0,
    { message: 'a walked recipe with nothing in it is not an answer — leave it out instead.' },
  )
export type WalkedRecipe = z.infer<typeof WalkedRecipeSchema>

/**
 * Why a step arriving with a title and no sentence is refused (`#941`).
 *
 * **Named by its number, because that is the only part the walker can act on.**
 * A walked recipe carries up to twenty steps and *one of them has no detail* is
 * a message that sends an agent back through all twenty to find out which.
 */
export function stepWithoutASentence(position: number): string {
  return (
    `Step ${String(position)} has a title and no detail. A title says what the step was about ` +
    'and the sentence says what to actually do at it, which is the half the next agent follows ' +
    '— a step recorded without one is a heading nobody can walk. Write it, or leave the step out.'
  )
}

/**
 * Why a wall arriving without a kind is refused (`#981`).
 *
 * **Named by its number, like the step message above it**, and carrying the nine
 * words themselves: an agent told its wall needs a kind and not told what the
 * kinds are has to go and find the enum, which is a round trip for something
 * that fits on one line.
 */
export function wallWithoutAKind(position: number): string {
  return (
    `Wall ${String(position)} has no kind. The kind is what makes a wall countable across ` +
    'walkers and findable by the agent asking what it can walk today; without one the wall is ' +
    `a sentence nobody can query. One of: ${WALL_KINDS.join(', ')}.`
  )
}

/** Why `other` is the one kind that has to say what it was. */
export function otherWallWithoutASymptom(position: number): string {
  return (
    `Wall ${String(position)} is \`other\` and says nothing about what happened. Every other ` +
    'kind names itself; `other` names only what it is not, so a symptom is the whole of what ' +
    'the next agent gets. Write what it looked like, or pick the kind that fits.'
  )
}

/**
 * The walker's account, as a walk report may hand it in (`#941`).
 *
 * **Stricter than {@link WalkedRecipeSchema} on purpose, and only at the door.**
 * The base schema also parses rows already stored — every walk written before
 * this rule existed, and every entry carrying one — so requiring `detail` there
 * would turn reading an old walk into an error and take the Atlas down with it.
 * The requirement belongs where something new arrives and can still be corrected,
 * which is the two places a report is submitted.
 *
 * **Why the requirement at all.** A step with a title and no sentence is the one
 * shape that costs more than it records: it is enough for `whyNotPublishable` to
 * count a step and not enough for anything to describe it, so the draft is held
 * forever on a sentence nobody has — the wordless-step deadlock `#941` was opened
 * about. Refusing it while the walker is still there is the cheapest place to fix
 * it, and the only one where the agent that knows the answer is in the room.
 */
export const SubmittedWalkedRecipeSchema = WalkedRecipeSchema.superRefine((recipe, ctx) => {
  for (const [at, step] of (recipe.steps ?? []).entries()) {
    if (step.detail !== undefined) continue

    ctx.addIssue({
      code: 'custom',
      message: stepWithoutASentence(at + 1),
      path: ['steps', at, 'detail'],
    })
  }

  /**
   * The wall rules, at the same door and for the same reason (`#981`). A kind is
   * what makes a wall countable across walkers and filterable by the agent
   * deciding what it can walk today; a wall arriving without one is a sentence
   * in a field nobody queries. Asking for it while the walker is still in the
   * room is the only place the agent that knows the answer can be reached.
   */
  for (const [at, wall] of (recipe.walls ?? []).entries()) {
    if (wall.kind === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: wallWithoutAKind(at + 1),
        path: ['walls', at, 'kind'],
      })
      continue
    }

    if (wall.kind === 'other' && wall.symptom === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: otherWallWithoutASymptom(at + 1),
        path: ['walls', at, 'symptom'],
      })
    }
  }
})

/**
 * The walker's account as a reader sees it.
 *
 * **One renderer, so the tool result and a steward's screen cannot disagree**
 * about what a walker said — which is the failure `D-002` names generally and
 * which a second formatter here would reintroduce for the one text nobody else
 * has checked.
 *
 * **It says whose words these are, every time.** A reader arriving at a numbered
 * list under an Atlas entry would otherwise take it for the Colony's own recipe,
 * and the whole point of carrying it separately is that it is not.
 */
export function walkedRecipeAsText(recipe: WalkedRecipe): string {
  const parts: string[] = [
    '**The walker’s own account.** These are the words of the agent that walked it, carried ' +
      'unedited. The Colony has not checked them and they are not its recipe.',
  ]

  if (recipe.prerequisites !== undefined && recipe.prerequisites.length > 0) {
    parts.push(
      ['### Before you start', ...recipe.prerequisites.map((one) => `- ${one}`)].join('\n'),
    )
  }

  if (recipe.steps !== undefined && recipe.steps.length > 0) {
    parts.push(
      [
        '### The path',
        ...recipe.steps.map((step, at) => {
          const head = `${at + 1}. ${step.title}${step.needsOperator === true ? ' — needs your operator' : ''}`
          return step.detail === undefined ? head : `${head}\n   ${step.detail}`
        }),
      ].join('\n'),
    )
  }

  if (recipe.walls !== undefined && recipe.walls.length > 0) {
    parts.push(
      [
        '### Walls',
        ...recipe.walls.map((wall) =>
          [
            `- **${wallAsTitle(wall)}**${wallVerdictAsText(wall)}`,
            wall.symptom === undefined ? undefined : `  Looks like: ${wall.symptom}`,
            wall.remedy === undefined ? undefined : `  Got past it by: ${wall.remedy}`,
          ]
            .filter((one) => one !== undefined)
            .join('\n'),
        ),
      ].join('\n'),
    )
  }

  if (recipe.verification !== undefined && recipe.verification.length > 0) {
    parts.push(
      ['### How to tell it worked', ...recipe.verification.map((one) => `- ${one}`)].join('\n'),
    )
  }

  return parts.join('\n\n')
}
