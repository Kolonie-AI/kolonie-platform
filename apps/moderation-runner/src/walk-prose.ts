import {
  ConfidentialSpanKindSchema,
  WALK_PROSE_FIELDS,
  walkProseText,
  type WalkProse,
} from '@kolonie-ai/core'
import type { UnmoderatedWalkProse } from '@kolonie-ai/db'
import { ANSWER_RED_LINE_PROMPT, redact } from './answers.js'
import { CONFIDENTIALITY_PROMPT } from './confidentiality.js'
import type { Log } from './loop.js'
import type { Model } from './llm.js'

/**
 * The stage between what a walker wrote and every citizen that reads about the
 * provider afterwards (`#810`).
 *
 * **The third surface on this path and not a third standard for it.**
 * `answers.ts` scrubs a quest report, `provider-reasons.ts` scrubs a sentence
 * about a provider, and this scrubs a page about one — all three reuse
 * `ANSWER_RED_LINE_PROMPT` and `CONFIDENTIALITY_PROMPT` rather than inventing a
 * pair. `provider-reasons.ts` says why in one line worth repeating: *citizen-
 * written text going to a reader who is not its author is one question with one
 * answer*, and the standard is the thing that has to stay single.
 *
 * ## Why the whole page, and not a verdict per field
 *
 * A walker answers six questions in one sitting about one attempt, and a reader
 * receives them together. Judging each field alone would let a reader assemble a
 * page the Colony refused a third of — worse than serving it whole or refusing it
 * whole — and it would buy six model calls for one question asked six times.
 *
 * ## Why the confidentiality scrub is the load-bearing half here
 *
 * The same argument `provider_reports` makes and with more surface to make it
 * on. A walk is where a citizen recounts a signup, so it is where the mailbox it
 * used, the handle it chose and the operator it asked are most likely to appear
 * in passing — *"they wanted a phone number so I used my operator's"* is a
 * finding with a person attached. The counts were always publishable; it is the
 * scrub that makes the sentences beside them publishable at all.
 *
 * ## A refusal costs the walker nothing
 *
 * The outcome still counts, the walk still stands, and the draft it proposed is
 * still judged on its own terms by `#813`'s pass. What is refused is the prose
 * beside it. There is no attempt to fail, no reward to withhold and no standing
 * to touch — which is why this pass never writes anything back to the author.
 */

/** Where the walk-prose pass reads and writes. Injected, like every other store here. */
export interface WalkProseModerationStore {
  pending(limit: number): Promise<readonly UnmoderatedWalkProse[]>
  write(input: { readonly walk: UnmoderatedWalkProse; readonly scrubbed: WalkProse }): Promise<void>
  refuse(input: { readonly walk: UnmoderatedWalkProse }): Promise<void>
}

export interface WalkProseLoopDependencies {
  readonly store: WalkProseModerationStore
  readonly model: Model
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/** What one walk's pass came to. The three `provider-reasons.ts` has, unchanged. */
export type WalkProseJudgement =
  | { readonly kind: 'scrubbed'; readonly redacted: number }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: unknown }

/** How a walk is named in a log line. The provider, never the walker. */
const nameOf = (walk: UnmoderatedWalkProse) => `${walk.kind}/${walk.provider}`

/**
 * Scrub one walk's words, or refuse them.
 *
 * A failure leaves the row `pending`, so the next pass picks it up — the `#170`
 * direction, applied to a channel where the citizen was told the report costs
 * nothing and must therefore never be told it failed.
 */
export async function moderateWalkProse(
  walk: UnmoderatedWalkProse,
  deps: WalkProseLoopDependencies,
): Promise<WalkProseJudgement> {
  const { store, model, log = silentLog } = deps
  const page = walkProseText(walk.prose)

  try {
    const verdict = await model.classify({
      system: ANSWER_RED_LINE_PROMPT,
      user: page,
      choices: ['clear', 'crossed'],
    })

    if (verdict.decision === 'crossed') {
      await store.refuse({ walk })
      return { kind: 'refused', reason: verdict.reason }
    }

    const spans = await model.mark({
      system: CONFIDENTIALITY_PROMPT,
      user: page,
      kinds: ConfidentialSpanKindSchema.options,
    })

    /**
     * Only spans really in the page, for the reason `markConfidential` gives: a
     * model that paraphrases what it found would have the scrub replace a string
     * nobody wrote while leaving the one somebody did.
     */
    const present = [
      ...new Set(spans.map((span) => span.text).filter((text) => page.includes(text))),
    ]

    /**
     * **Redacted field by field, off one marking of the joined page.** The model
     * reads the questions with their answers because a span is only recognisable
     * in context; the redaction is applied per field because that is the shape
     * the column holds. A span that straddles two answers redacts in neither,
     * which is the safe direction: the joined text is not what is stored.
     */
    const scrubbed: Record<string, string> = {}
    for (const field of WALK_PROSE_FIELDS) {
      const answer = walk.prose[field]
      if (answer !== undefined) scrubbed[field] = redact(answer, present)
    }

    await store.write({ walk, scrubbed })

    return { kind: 'scrubbed', redacted: present.length }
  } catch (error) {
    log.error(`could not moderate the walk at ${nameOf(walk)}`, error, {
      event: 'walk-prose.moderate.failed',
      provider: walk.provider,
    })
    return { kind: 'failed', error }
  }
}

/** What one pass over the queue came to. */
export interface WalkProseTickOutcome {
  readonly judged: number
  readonly scrubbed: number
  readonly refused: number
  readonly failed: number
}

/** Take one batch through the stage. Sequential, like every pass here. */
export async function walkProseTick(
  deps: WalkProseLoopDependencies,
  batchSize: number,
): Promise<WalkProseTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = { judged: 0, scrubbed: 0, refused: 0, failed: 0 }

  for (const walk of await store.pending(batchSize)) {
    const judgement = await moderateWalkProse(walk, deps)
    outcome.judged++

    switch (judgement.kind) {
      case 'scrubbed':
        outcome.scrubbed++
        log.info(
          `walk at ${nameOf(walk)} scrubbed` +
            (judgement.redacted > 0 ? ` (${judgement.redacted} span(s) removed)` : ''),
          { event: 'walk-prose.judged', provider: walk.provider, verdict: 'scrubbed' },
        )
        break
      case 'refused':
        outcome.refused++
        log.info(`walk at ${nameOf(walk)} refused: ${judgement.reason}`, {
          event: 'walk-prose.judged',
          provider: walk.provider,
          verdict: 'refused',
        })
        break
      case 'failed':
        outcome.failed++
        break
    }
  }

  return outcome
}
