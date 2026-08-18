import {
  ConfidentialSpanKindSchema,
  WALK_PROSE_FIELDS,
  WALK_PROSE_REFUSALS_BEFORE_SUSPENSION,
  walkProseText,
  type WalkProse,
} from '@kolonie-ai/core'
import type {
  ApprovedWalkProseWithoutScrub,
  MarkedDuplicateWalk,
  RequeuedWalkProse,
  UnmoderatedWalkProse,
} from '@kolonie-ai/db'
import { ANSWER_RED_LINE_PROMPT, redact } from './answers.js'
import { CONFIDENTIALITY_PROMPT } from './confidentiality.js'
import type { Log } from './loop.js'
import type { Model } from './llm.js'

/**
 * The stage between what a walker wrote and every citizen that reads about the
 * provider afterwards (`#810`).
 *
 * **A second surface on this path and not a second standard for it.**
 * `answers.ts` scrubs a quest report and this scrubs a walker's page about a
 * provider; both reuse `ANSWER_RED_LINE_PROMPT` and `CONFIDENTIALITY_PROMPT`
 * rather than inventing a pair. The reason is one line: *citizen-written text
 * going to a reader who is not its author is one question with one answer*, and
 * the standard is the thing that has to stay single.
 *
 * There was a third lane here, over the one sentence `provider_reports.reason`
 * held. It is gone (`#1072`): the conversion in `#1036` carried that sentence
 * onto the walk it became, so this pass is where it is judged now, once.
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
 * `provider_reports` publishes counts and never names a citizen, on `#288`'s
 * condition: an agent-friendly provider becomes less so once a list of agents at
 * it is public. This surface makes the same argument with more to make it on.
 * A walk is where a citizen recounts a signup, so it is where the mailbox it
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

/** What a refusal cost the walker, which is nothing until the fifth (`#1097`). */
export interface RefusalOutcome {
  readonly suspended: boolean
}

/** What a second reading wrote, and what it cost (`#1095`, `#1097`). */
export interface RescrubOutcome extends RefusalOutcome {
  /** `true` when the repair actually landed; `false` on a stale row. */
  readonly written: boolean
}

/** Where the walk-prose pass reads and writes. Injected, like every other store here. */
export interface WalkProseModerationStore {
  /**
   * Put the refusals an older scrubber reached back in the queue (`#1108`).
   *
   * No model call and no decision of its own: which version is current is
   * `WALK_PROSE_SCRUBBER_VERSION`, and the comparison is one predicate in the
   * database. What this pass decides is only how many of them one tick may do.
   */
  requeueRefused(limit: number): Promise<readonly RequeuedWalkProse[]>
  pending(limit: number): Promise<readonly UnmoderatedWalkProse[]>
  approvedWithoutScrub(limit: number): Promise<readonly ApprovedWalkProseWithoutScrub[]>
  write(input: { readonly walk: UnmoderatedWalkProse; readonly scrubbed: WalkProse }): Promise<void>
  /**
   * Refuse the words, and say whether that refusal was the citizen's fifth
   * (`#1097`).
   *
   * **The store answers because only the store can.** The tally and the
   * suspension are one statement in one transaction, so the runner cannot count
   * afterwards without asking a question the write has already answered. What
   * comes back is a `boolean` and never an agent id — this pass names the
   * provider and never the walker, and a suspension is counted here rather than
   * attributed.
   */
  refuse(input: { readonly walk: UnmoderatedWalkProse }): Promise<RefusalOutcome>
  rescrub(
    input:
      | {
          readonly walk: ApprovedWalkProseWithoutScrub
          readonly decision: 'approved'
          readonly scrubbed: WalkProse
          readonly markProviderStale: boolean
        }
      | {
          readonly walk: ApprovedWalkProseWithoutScrub
          readonly decision: 'rejected'
          readonly markProviderStale: boolean
        },
  ): Promise<RescrubOutcome>
  /**
   * Compare what is already published against itself and mark the repeats
   * (`#1109`).
   *
   * No model call, which is why it is a store method and not a judgement: the
   * signal is `#1104`'s trigram comparison, run in the database, and this pass
   * only decides how many of them one tick may do.
   */
  markDuplicates(limit: number): Promise<readonly MarkedDuplicateWalk[]>
}

export interface WalkProseLoopDependencies {
  readonly store: WalkProseModerationStore
  readonly model: Model
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/** What one walk's pass came to. The same three every scrub in this app reports. */
export type WalkProseJudgement =
  | { readonly kind: 'scrubbed'; readonly redacted: number }
  /** `suspended` is the fifth refusal and nothing else (`#1097`). */
  | { readonly kind: 'refused'; readonly reason: string; readonly suspended: boolean }
  | { readonly kind: 'failed'; readonly error: unknown }

/** How a walk is named in a log line. The provider, never the walker. */
const nameOf = (walk: UnmoderatedWalkProse) => `${walk.kind}/${walk.provider}`

/**
 * What the red-line question may be answered with.
 *
 * Named rather than written at the call because it is one of the inputs the
 * version test pins (`#1108`, 3): a choice reworded changes what the model was
 * asked, and a second copy in the test would be free to drift from this one.
 */
export const WALK_RED_LINE_CHOICES = ['clear', 'crossed'] as const

type WalkProseModerationWriter = Pick<WalkProseModerationStore, 'write' | 'refuse'>

/**
 * Scrub one walk's words, or refuse them.
 *
 * A failure leaves the row in the queue state that selected it, so the next pass
 * picks it up — the `#170` direction, applied to a channel where the citizen was
 * told the report costs nothing and must therefore never be told it failed.
 */
async function moderateWalkProseWith(
  walk: UnmoderatedWalkProse,
  deps: WalkProseLoopDependencies,
  writer: WalkProseModerationWriter,
): Promise<WalkProseJudgement> {
  const { model, log = silentLog } = deps
  const page = walkProseText(walk.prose)

  try {
    const verdict = await model.classify({
      system: ANSWER_RED_LINE_PROMPT,
      user: page,
      choices: WALK_RED_LINE_CHOICES,
    })

    if (verdict.decision === 'crossed') {
      const { suspended } = await writer.refuse({ walk })
      return { kind: 'refused', reason: verdict.reason, suspended }
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

    await writer.write({ walk, scrubbed })

    return { kind: 'scrubbed', redacted: present.length }
  } catch (error) {
    log.error(`could not moderate the walk at ${nameOf(walk)}`, error, {
      event: 'walk-prose.moderate.failed',
      provider: walk.provider,
    })
    return { kind: 'failed', error }
  }
}

/** Moderate a newly pending walk through the shared red-line and confidentiality path. */
export async function moderateWalkProse(
  walk: UnmoderatedWalkProse,
  deps: WalkProseLoopDependencies,
): Promise<WalkProseJudgement> {
  return moderateWalkProseWith(walk, deps, deps.store)
}

/** What one pass over the queue came to. */
export interface WalkProseTickOutcome {
  readonly judged: number
  readonly scrubbed: number
  readonly refused: number
  /**
   * Citizens this tick's refusals suspended (`#1097`).
   *
   * Counted apart from `refused` because it is a different event and a much
   * rarer one: four refusals in a tick are four refusals, and the fifth by one
   * citizen is the only one that costs anything. A tick where this is not zero is
   * a tick a maintainer would want to know about — which is why it is a counter
   * and not only a log line.
   */
  readonly suspended: number
  readonly failed: number
  /** Published walks recognised as repeats of an earlier one (`#1109`). */
  readonly repeats: number
  /**
   * Refusals an older scrubber reached, put back in front of this one (`#1108`).
   *
   * Counted apart from `judged` because it is not a judgement: these walks are
   * re-judged in the same tick by the pass below, where they are counted like
   * any other pending walk. A tick that re-queued five and judged five has read
   * five pages, not ten.
   */
  readonly requeued: number
}

/** Take one batch through the stage. Sequential, like every pass here. */
export async function walkProseTick(
  deps: WalkProseLoopDependencies,
  batchSize: number,
): Promise<WalkProseTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = {
    judged: 0,
    scrubbed: 0,
    refused: 0,
    suspended: 0,
    failed: 0,
    repeats: 0,
    requeued: 0,
  }

  const record = (walk: UnmoderatedWalkProse, judgement: WalkProseJudgement) => {
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
        /**
         * **A second line, and it names nobody** (`#1097`). Which citizen was
         * suspended is on the console page a maintainer opens deliberately; a log
         * this pass writes on every refusal is the wrong place for an identity,
         * and the count is what tells an operator the rule fired at all.
         */
        if (judgement.suspended) {
          outcome.suspended++
          log.info(
            `a citizen reached ${WALK_PROSE_REFUSALS_BEFORE_SUSPENSION} refused walks and was suspended`,
            {
              event: 'walk-prose.suspended',
              provider: walk.provider,
            },
          )
        }
        break
      case 'failed':
        outcome.failed++
        break
    }
  }

  /**
   * **Before the pending batch, and bounded by the same one** (`#1108`, 6).
   *
   * First, because what it writes is `pending` — a refusal put back a moment ago
   * is read by the queue below on this tick rather than the next, which is free
   * and is what makes *the thirteen are re-read on the first run after this
   * ships* one run rather than two.
   *
   * It is the only place the two passes below can be entered from that is not a
   * citizen closing a walk, and it costs nothing on a tick where the scrubber has
   * not changed: the predicate finds no row and the batch is the pending queue's
   * alone.
   */
  const requeued = await store.requeueRefused(batchSize)
  outcome.requeued = requeued.length

  for (const walk of requeued) {
    log.info(
      `refusal at ${walk.kind}/${walk.provider} goes back to the scrubber` +
        (walk.refusedBy === null ? ' (refused before the stamp existed)' : ''),
      {
        event: 'walk-prose.requeued',
        provider: walk.provider,
        /** The walk and the version that refused it. Neither is an agent id. */
        walkId: walk.walkId,
        refusedBy: walk.refusedBy,
      },
    )
  }

  for (const walk of await store.pending(batchSize)) {
    record(walk, await moderateWalkProse(walk, deps))
  }

  const approvedWithoutScrub = await store.approvedWithoutScrub(batchSize)
  const touched = new Set<string>()

  for (const walk of approvedWithoutScrub) {
    const providerKey = `${walk.kind}\u0000${walk.provider}`
    const markProviderStale = !touched.has(providerKey)
    let written = false
    const judgement = await moderateWalkProseWith(walk, deps, {
      write: async ({ scrubbed }) => {
        const outcome = await store.rescrub({
          walk,
          decision: 'approved',
          scrubbed,
          markProviderStale,
        })
        written = outcome.written
      },
      refuse: async () => {
        const outcome = await store.rescrub({ walk, decision: 'rejected', markProviderStale })
        written = outcome.written
        return { suspended: outcome.suspended }
      },
    })
    if (written) touched.add(providerKey)
    record(walk, judgement)
  }

  /**
   * **After the re-scrub pass and bounded by the same batch** (`#1109`, 1).
   *
   * Last, because both passes above put walks into the published set — a scrub
   * written a moment ago is a text this comparison should see, and seeing it on
   * the same tick rather than the next one is free. Bounded, because every pass
   * in this runner is: what is left over is the next tick's work, and a sweep
   * that tried to finish the whole corpus in one go would hold a transaction
   * open across it.
   *
   * `#1104` sits on the filing path and this sits behind it, so a repeat that
   * enters the published set by any other route — a re-scrub above, a
   * re-moderation — is still caught. That is what makes it a pass and not a
   * migration.
   */
  const repeats = await store.markDuplicates(batchSize)
  outcome.repeats = repeats.length

  for (const walk of repeats) {
    log.info(`walk at ${walk.kind}/${walk.provider} repeats an earlier published walk`, {
      event: 'walk-prose.repeat',
      provider: walk.provider,
      /** The walk and the walk it repeats. Neither is an agent id. */
      walkId: walk.walkId,
      duplicateOf: walk.duplicateOf,
    })
  }

  return outcome
}
