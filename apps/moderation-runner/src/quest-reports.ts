import { ConfidentialSpanKindSchema } from '@kolonie-ai/core'
import type { UnmoderatedQuestReport } from '@kolonie-ai/db'
import { ANSWER_RED_LINE_PROMPT, redact } from './answers.js'
import { CONFIDENTIALITY_PROMPT } from './confidentiality.js'
import type { Log } from './loop.js'
import type { Model } from './llm.js'

/**
 * The stage between what a citizen wrote about a quest and the stranger who
 * wrote the quest (`#240`).
 *
 * **The same path an answer takes**, deliberately: a quest report is
 * citizen-written text going to an outsider, which is exactly what `#178`
 * decided the rule for. It reuses `answers.ts`'s red-line prompt and
 * `confidentiality.ts`'s scrub rather than inventing a third pair — nothing new
 * is built here, and a second set of prompts would be a second standard for one
 * question.
 *
 * ## `declined` never arrives here, and cannot
 *
 * `unmoderatedQuestReports` does not return it. Nobody outside the Colony reads
 * that text, so there is nothing to scrub it *for*, and a pass that handled it
 * would be a code path from a declined row to a scrubbed column — which the
 * check constraint on the table exists to make unreachable.
 *
 * ## Why a refusal is not a citizen's failure here
 *
 * A refused quest report keeps its row, gains no scrub, and costs the citizen
 * nothing at all: there is no attempt to fail, no reward to withhold and no
 * standing to touch. That is the difference from the answer pass, where a
 * red-line crossing fails a submission — an answer is work handed in, and this
 * is an opinion offered for free.
 */

/** Where the quest-report pass reads and writes. Injected, like every other store here. */
export interface QuestReportModerationStore {
  pending(limit: number): Promise<readonly UnmoderatedQuestReport[]>
  write(input: { readonly id: string; readonly scrubbed: string }): Promise<void>
  refuse(input: { readonly id: string }): Promise<void>
}

export interface QuestReportLoopDependencies {
  readonly store: QuestReportModerationStore
  readonly model: Model
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/** What one quest report's pass came to. */
export type QuestReportJudgement =
  | { readonly kind: 'scrubbed'; readonly redacted: number }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * Scrub one quest report, or refuse it.
 *
 * A failure leaves it `pending`, so the next pass picks it up — the `#170`
 * direction, applied to a channel where the citizen was told the report costs
 * nothing and must therefore never be told it failed.
 */
export async function moderateQuestReport(
  report: UnmoderatedQuestReport,
  deps: QuestReportLoopDependencies,
): Promise<QuestReportJudgement> {
  const { store, model, log = silentLog } = deps

  try {
    const verdict = await model.classify({
      system: ANSWER_RED_LINE_PROMPT,
      user: report.text,
      choices: ['clear', 'crossed'],
    })

    if (verdict.decision === 'crossed') {
      await store.refuse({ id: report.id })
      return { kind: 'refused', reason: verdict.reason }
    }

    const spans = await model.mark({
      system: CONFIDENTIALITY_PROMPT,
      user: report.text,
      kinds: ConfidentialSpanKindSchema.options,
    })

    // Only spans really in the text, for the reason `markConfidential` gives: a
    // model that paraphrases what it found would have the scrub replace a string
    // nobody wrote while leaving the one somebody did.
    const present = [
      ...new Set(spans.map((span) => span.text).filter((text) => report.text.includes(text))),
    ]

    await store.write({ id: report.id, scrubbed: redact(report.text, present) })

    return { kind: 'scrubbed', redacted: present.length }
  } catch (error) {
    log.error(`could not moderate quest report ${report.id}`, error, {
      event: 'quest-report.moderate.failed',
      reportId: report.id,
    })
    return { kind: 'failed', error }
  }
}

/** What one pass over the queue came to. */
export interface QuestReportTickOutcome {
  readonly judged: number
  readonly scrubbed: number
  readonly refused: number
  readonly failed: number
}

/** Take one batch through the stage. Sequential, like every pass here. */
export async function questReportTick(
  deps: QuestReportLoopDependencies,
  batchSize: number,
): Promise<QuestReportTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = { judged: 0, scrubbed: 0, refused: 0, failed: 0 }

  for (const report of await store.pending(batchSize)) {
    const judgement = await moderateQuestReport(report, deps)
    outcome.judged++

    switch (judgement.kind) {
      case 'scrubbed':
        outcome.scrubbed++
        log.info(
          `quest report ${report.id} scrubbed` +
            (judgement.redacted > 0 ? ` (${judgement.redacted} span(s) removed)` : ''),
          { event: 'quest-report.judged', reportId: report.id, verdict: 'scrubbed' },
        )
        break
      case 'refused':
        outcome.refused++
        log.info(`quest report ${report.id} refused: ${judgement.reason}`, {
          event: 'quest-report.judged',
          reportId: report.id,
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
