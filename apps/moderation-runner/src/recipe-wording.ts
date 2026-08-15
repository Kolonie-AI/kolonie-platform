import {
  RECIPE_STEP_MAX_LENGTH,
  looksLikeCredential,
  type DraftWording,
  type ProviderRecipe,
} from '@kolonie-ai/core'
import type { Model } from './llm.js'
import { RECIPE_WORDING_PROMPT } from './recipe-prompts.js'

/**
 * Forming the sentence a walked step arrived without (`#941`).
 *
 * ## The deadlock this ends
 *
 * A walk records **actions with the wording genuinely missing** — `walkToSteps`
 * writes the position, the actor and whether an operator was there, and never an
 * instruction, because `#517` reserves the sentence a recipe publishes to the
 * Colony and the walk did not observe one. `whyNotPublishable` then holds every
 * such draft on *the sentence describing it is still the Colony's to write*,
 * which was true and, until `#857`, unanswerable by anybody: the curation screen
 * offered a Publish button the wordless step refused and a Refuse button that
 * empties the row. `#857` gave a steward somewhere to write it. Nobody did, and
 * four drafts sat there.
 *
 * ## What changed, and by exactly how much
 *
 * The pass is widened **one notch**: it may form a step's sentence out of what
 * the walker recorded on that same walk, and it may not write a step the walk
 * records nothing at all for. Those are two halves of one rule rather than a
 * permission and a caveat — the whole reason a wordless step is held is that
 * publishing an unrecorded path is worse than publishing nothing, and a stage
 * that could invent would reintroduce that at machine speed.
 *
 * ## Why citations, and not a better prompt
 *
 * `model.compose` answers with claims that each name their sources over a closed
 * set, so *did this sentence come from something recorded* is arithmetic here
 * rather than a matter of trusting the answer: a claim citing nothing, or citing
 * an id that is not in the corpus, is dropped before anything is written, and the
 * step it was for stays wordless and stays held.
 *
 * **What that does not catch, said plainly.** A model that invents a sentence
 * *and* cites a source that exists gets through this. The citation makes the
 * invention auditable rather than impossible — the same bargain `synthesis.ts`
 * strikes, and the reason the formed sentences are recorded on the verdict with
 * what they cited rather than only counted.
 */

/** What one piece of recorded material is, as the model reads it. */
export interface RecordedSource {
  readonly id: string
  readonly text: string
}

/**
 * The walk's own narrative, carried beside the entry.
 *
 * The three of `#809`'s four questions that describe the path. `discarded` is
 * deliberately not here: it is what the walker *did not* do, and a sentence
 * formed out of a route somebody abandoned is the worst of both halves.
 */
export interface WalkNarrative {
  readonly did?: string | null
  readonly broke?: string | null
  readonly changed?: string | null
}

/** What one attempt at wording a draft came to. */
export type WordingOutcome =
  /** No step is missing its sentence. The common case, and it pays for nothing. */
  | { readonly kind: 'not-needed' }
  /** Every wordless step now has a sentence drawn from something recorded. */
  | {
      readonly kind: 'formed'
      readonly wording: DraftWording['steps']
      readonly cited: readonly { readonly position: number; readonly sources: readonly string[] }[]
    }
  /** At least one step has nothing recorded to describe it, and is named. */
  | { readonly kind: 'nothing-recorded'; readonly positions: readonly number[] }

/** The 1-based positions of the steps the Colony observed without a sentence. */
export function wordlessSteps(recipe: ProviderRecipe): readonly number[] {
  return recipe.steps
    .map((step, at) => (step.instruction === undefined ? at + 1 : undefined))
    .filter((position): position is number => position !== undefined)
}

/**
 * Everything the walk recorded that a sentence may be drawn from.
 *
 * **The walker's own account first, the narrative after**, and both closed: an id
 * outside this list cannot be cited, so the corpus is the whole of what the stage
 * is allowed to have read.
 *
 * **The walker's steps are not assumed to line up with the observed ones.** A
 * walker's account is prose written afterwards and the observed steps are what
 * the Colony saw as it happened; they routinely differ in number and in order. So
 * every recorded step is offered as material for every wordless one, and which
 * describes which is what the citation says.
 */
export function recordedMaterial(
  recipe: ProviderRecipe,
  narrative: WalkNarrative | undefined,
): readonly RecordedSource[] {
  const walked = recipe.walkedRecipe
  const sources: RecordedSource[] = []

  for (const [at, step] of (walked?.steps ?? []).entries()) {
    sources.push({
      id: `walked-step-${String(at + 1)}`,
      text: [
        step.title,
        step.detail,
        step.needsOperator === true
          ? 'The walker recorded this as needing its operator.'
          : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(' — '),
    })
  }

  for (const [at, one] of (walked?.prerequisites ?? []).entries()) {
    sources.push({ id: `prerequisite-${String(at + 1)}`, text: one })
  }

  for (const [at, wall] of (walked?.walls ?? []).entries()) {
    sources.push({
      id: `wall-${String(at + 1)}`,
      text: [wall.title, wall.symptom, wall.remedy]
        .filter((part) => part !== undefined)
        .join(' — '),
    })
  }

  for (const [at, one] of (walked?.verification ?? []).entries()) {
    sources.push({ id: `verification-${String(at + 1)}`, text: one })
  }

  for (const [id, text] of [
    ['did', narrative?.did],
    ['broke', narrative?.broke],
    ['changed', narrative?.changed],
  ] as const) {
    if (text !== undefined && text !== null && text.trim().length > 0) {
      sources.push({ id, text: text.trim() })
    }
  }

  return sources
}

/** What the model is shown: the steps it is wording, and the corpus it may draw on. */
function wordingText(recipe: ProviderRecipe, sources: readonly RecordedSource[]): string {
  return [
    `Provider: ${recipe.provider}`,
    `Account kind: ${recipe.kind}`,
    '',
    'The observed steps, in order. The ones marked NEEDS A SENTENCE are the ones',
    'you are asked about; the others are given so the order reads.',
    ...recipe.steps.map((step, at) => {
      const head = `${String(at + 1)}. [${step.actor}]`
      return step.instruction === undefined
        ? `${head} NEEDS A SENTENCE (section "step-${String(at + 1)}")`
        : `${head} ${step.instruction}`
    }),
    '',
    'The recorded material. Cite by the id in brackets and by nothing else.',
    ...sources.map((source) => `[${source.id}] ${source.text}`),
  ].join('\n')
}

/**
 * Form what is missing, or say which step nothing was recorded for.
 *
 * Never throws for a claim it dislikes: an unusable claim is dropped and the step
 * it was for is reported as unrecorded, which is the same outcome as the model
 * having said nothing about it. Only the call itself can fail, and `judgeDraft`
 * treats that as it treats every other unreachable model — the draft stays a
 * draft and the next tick tries again.
 */
export async function formStepSentences(
  recipe: ProviderRecipe,
  narrative: WalkNarrative | undefined,
  model: Model,
): Promise<WordingOutcome> {
  const missing = wordlessSteps(recipe)
  if (missing.length === 0) return { kind: 'not-needed' }

  const sources = recordedMaterial(recipe, narrative)
  /** Nothing recorded at all: the corpus is empty, so there is nothing to ask about. */
  if (sources.length === 0) return { kind: 'nothing-recorded', positions: missing }

  const sections = missing.map((position) => `step-${String(position)}`)
  const allowed = new Set(sources.map((source) => source.id))

  const claims = await model.compose({
    system: RECIPE_WORDING_PROMPT,
    user: wordingText(recipe, sources),
    sections,
    sourceIds: sources.map((source) => source.id),
    maxClaimLength: RECIPE_STEP_MAX_LENGTH,
  })

  const formed = new Map<number, { readonly text: string; readonly sources: readonly string[] }>()

  for (const claim of claims) {
    const position = missing.find((one) => claim.section === `step-${String(one)}`)
    if (position === undefined) continue
    /** First claim per step wins; a second is a second opinion nobody asked for. */
    if (formed.has(position)) continue

    /**
     * **The guard, and it is three tests rather than one.** A claim citing
     * nothing came from nothing. A claim citing an id outside the corpus cited
     * something it was not given. And a sentence that trips `looksLikeCredential`
     * carries a value a walker recorded, which is the one thing a published
     * recipe must never do — the same test `RecipeStepSchema` applies, applied
     * here because this is where a sentence is born rather than submitted.
     */
    const cited = claim.sources.filter((id) => allowed.has(id))
    const text = claim.text.trim()
    if (cited.length === 0 || text.length === 0) continue
    if (text.length > RECIPE_STEP_MAX_LENGTH) continue
    if (looksLikeCredential(text)) continue

    formed.set(position, { text, sources: cited })
  }

  const unrecorded = missing.filter((position) => !formed.has(position))
  if (unrecorded.length > 0) return { kind: 'nothing-recorded', positions: unrecorded }

  return {
    kind: 'formed',
    /**
     * Positional and complete, because `dressWalkedSteps` requires one entry per
     * observed step and attaches them by index. A step that already had its
     * sentence keeps it — this stage writes what was missing and rewrites nothing.
     */
    wording: recipe.steps.map((step, at) => ({
      instruction: step.instruction ?? (formed.get(at + 1)?.text as string),
    })),
    cited: [...formed.entries()].map(([position, one]) => ({ position, sources: one.sources })),
  }
}

/** Why a draft nothing could be written for is held, naming the steps. */
export function nothingRecordedFor(positions: readonly number[]): string {
  const named =
    positions.length === 1
      ? `Step ${String(positions[0])} has`
      : `Steps ${positions.map(String).join(', ')} have`

  return (
    `${named} nothing recorded to describe ${positions.length === 1 ? 'it' : 'them'}. The walk ` +
    'recorded that the step happened and the walker wrote nothing about it, so there is no ' +
    'sentence to form that would not be invented — and an invented step is one the next agent ' +
    'follows. Walk it again and describe each step, or leave the step out.'
  )
}
