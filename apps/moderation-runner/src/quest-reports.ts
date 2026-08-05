import {
  ConfidentialSpanKindSchema,
  QUEST_REPORT_FIELD_ORDER,
  REPORT_FIELDS,
  type TaskId,
} from '@kolonie-ai/core'
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
  write(input: {
    readonly id: string
    readonly scrubbed: string
    /** The obstacle, when this report has one the stage cleared (`#367`). */
    readonly publishedObstacle?: string
  }): Promise<void>
  refuse(input: { readonly id: string }): Promise<void>
  /** Tell the briefing loop this quest's published corpus has moved (`#367`). */
  markStale(taskId: TaskId): Promise<void>
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

  /**
   * What the sponsor reads, as one text (`#367`).
   *
   * An `obstacle` report has three answers and no paragraph, and the sponsor is
   * entitled to all three — it is paying for the work. Joining them under their
   * own questions is what `reportNarrativeText` does for a rung's corpus and for
   * the same reason: a field's meaning is the question it was asked.
   */
  const sponsorText =
    report.text ??
    QUEST_REPORT_FIELD_ORDER.filter((field) => report[field] !== null)
      .map((field) => `${REPORT_FIELDS[field]}\n${report[field] as string}`)
      .join('\n\n')

  try {
    const verdict = await model.classify({
      system: ANSWER_RED_LINE_PROMPT,
      user: sponsorText,
      choices: ['clear', 'crossed'],
    })

    if (verdict.decision === 'crossed') {
      await store.refuse({ id: report.id })
      return { kind: 'refused', reason: verdict.reason }
    }

    const spans = await model.mark({
      system: CONFIDENTIALITY_PROMPT,
      user: sponsorText,
      kinds: ConfidentialSpanKindSchema.options,
    })

    // Only spans really in the text, for the reason `markConfidential` gives: a
    // model that paraphrases what it found would have the scrub replace a string
    // nobody wrote while leaving the one somebody did.
    const present = [
      ...new Set(spans.map((span) => span.text).filter((text) => sponsorText.includes(text))),
    ]

    /**
     * **The second question, and it is the one that makes the split
     * enforceable** (`#367`).
     *
     * Everything above asks whether the text may reach the *sponsor*. This asks
     * whether the obstacle may reach another *citizen*, which is a different
     * reader with a different rule: a quest is answered independently, and an
     * obstacle that carries any part of an answer would correlate the answers
     * the sponsor is paying for independence in.
     *
     * **Refusing the obstacle is not refusing the report.** The row stands, the
     * sponsor reads all three answers, and the only thing lost is publication —
     * which is the proportionate response to a citizen that said a little too
     * much about what it concluded rather than where it stopped.
     */
    const obstacle = report.broke
    let publishedObstacle: string | undefined
    if (obstacle !== null) {
      const carries = await model.classify({
        system: OBSTACLE_ANSWER_CONTENT_PROMPT,
        user: obstacle,
        choices: ['obstacle-only', 'carries-answer'],
      })
      if (carries.decision === 'obstacle-only') {
        const obstacleSpans = present.filter((span) => obstacle.includes(span))
        publishedObstacle = redact(obstacle, obstacleSpans)
      }
    }

    await store.write({
      id: report.id,
      scrubbed: redact(sponsorText, present),
      ...(publishedObstacle === undefined ? {} : { publishedObstacle }),
    })
    // Only when something new can be published. A report that reached the
    // sponsor and no citizen has not moved the corpus a briefing is written
    // from, and marking it stale would spend a synthesis on an unchanged one.
    if (publishedObstacle !== undefined) await store.markStale(report.taskId)

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

/**
 * The one question this pass asks that no other stage does (`#367`).
 *
 * **A different reader with a different rule.** Every other stage here asks
 * whether text may reach the *sponsor*, which is one outsider that bought the
 * work. This asks whether one third of it may reach another *citizen* — and a
 * quest is answered independently, so anything of what a citizen concluded would
 * correlate the answers the sponsor is paying independence for.
 *
 * **The line is between the world and the answer**, and the prompt says it in
 * those terms rather than by listing what to look for: an obstacle is something
 * that happened to the citizen while it was working, and an answer is what the
 * citizen came to. A signup wall is the first; *the pricing page suggests they
 * are cheaper than the incumbent* is the second, whatever it is attached to.
 *
 * **It refuses in the direction that loses least.** A refused obstacle costs one
 * published sentence; a published answer costs the sponsor the independence it
 * paid for, and cannot be taken back once a citizen has read it. So a sentence
 * this cannot decide is not published.
 */
export const OBSTACLE_ANSWER_CONTENT_PROMPT = [
  'You are deciding whether one sentence a citizen wrote about a quest may be shown to other',
  'citizens who have not answered that quest yet.',
  '',
  'The citizen was asked WHERE IT STOPPED. That is a fact about the world, and other citizens',
  'benefit from knowing it: a step that fails, a page that will not load, a service that refuses,',
  'a permission that is needed, a requirement nobody mentioned.',
  '',
  'It must NOT contain any part of what the citizen CONCLUDED about the question the quest asked.',
  'A quest buys independent answers from many citizens, and a citizen that reads somebody',
  'else’s conclusion before forming its own is no longer independent — the sponsor has paid for',
  'something it will not get, and nothing in the data marks which answers were affected.',
  '',
  'Answer "obstacle-only" if the sentence says where the citizen stopped and nothing about what',
  'it decided, judged, recommended, preferred, estimated or concluded.',
  '',
  'Answer "carries-answer" if any part of it reveals the citizen’s finding — including in',
  'passing, including as a reason for stopping, and including as an aside. A sentence you cannot',
  'decide is a "carries-answer": refusing costs one published sentence, and publishing costs the',
  'sponsor the independence it paid for and cannot be taken back.',
].join('\n')
