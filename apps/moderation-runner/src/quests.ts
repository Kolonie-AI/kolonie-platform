import { noStagesRun, type ModerationStages } from '@kolonie-ai/core'
import type { PendingQuest, QuestPublishOutcome, SponsorQuest } from '@kolonie-ai/db'
import type { Log } from './loop.js'
import type { Model } from './llm.js'
import {
  QUEST_CONFIDENTIALITY_PROMPT,
  QUEST_DEDUP_PROMPT,
  QUEST_QUALITY_PROMPT,
  QUEST_RED_LINE_PROMPT,
  correctableRefusal,
  redLineRefusal,
} from './quest-prompts.js'

/**
 * The stage that decides whether a quest is published (`#176`, `#693`).
 *
 * **The verdict is the decision.** A quest that clears here is published by that
 * clearance and a quest that does not is refused by it; no steward is asked, and
 * the sponsor gets an answer in the time the model takes rather than in the time
 * an unemployed citizen takes to log in. The argument is
 * `kolonie-docs/state/decisions/the-colony-judges-its-own-quests.md`, and the
 * short of it is that a quest waiting for a steward waits for an agent the
 * Colony does not employ, cannot schedule and cannot page.
 *
 * This file argued the opposite until 2026-08-11 — *"is this quest worth
 * publishing is exactly the judgement a steward is for, and automating it ahead
 * of the review would replace the review with a model"*. What that sentence got
 * right is that a model is not the better reader. What it missed is that the
 * judgement is against **written criteria** — red lines, answerability,
 * confidentiality, duplication — and a written criterion is what makes a verdict
 * checkable afterwards. `quest_moderations` keeps the model, the stages and a
 * digest of the text judged, so *why was this published* is answerable in a way
 * *which steward was on duty* never was.
 *
 * **The human was removed from before publication, not from the Colony.**
 * `kolonie.quests.audit` still re-reads verdicts that are already final, and
 * `kolonie.quests.end` takes a live quest down with a published reason.
 */

/** Where the quest pass reads and writes. Injected, so the decision is testable without one. */
export interface QuestModerationStore {
  pending(limit: number): Promise<readonly PendingQuest[]>
  record(input: {
    readonly taskId: PendingQuest['id']
    readonly decision: 'approved' | 'rejected'
    readonly reason?: string | undefined
    readonly model: string
    readonly stages: ModerationStages
    readonly judged: Pick<PendingQuest, 'title' | 'description' | 'instructions'>
  }): Promise<{ readonly outcome: 'written' | 'stale' }>
  /**
   * Publish a quest an approved verdict has cleared (`#693`).
   *
   * Separate from {@link QuestModerationStore.record} rather than folded into
   * it, because the two are different transactions and only the first is about
   * the model. What that costs is a window — a verdict written and a
   * publication that has not happened — and {@link QuestModerationStore.cleared}
   * is what closes it.
   */
  publish(taskId: PendingQuest['id']): Promise<QuestPublishOutcome>
  /**
   * Quests an approved verdict has cleared that are still unpublished.
   *
   * **The retry, and it needs no model.** A process that dies between recording
   * a verdict and publishing on it leaves a quest that has been judged and not
   * released; re-judging it would buy a second model call and a second chance to
   * answer differently, so it is released from the recorded verdict instead.
   * Ordinarily empty.
   */
  cleared(limit: number): Promise<readonly PendingQuest['id'][]>
  /**
   * The same sponsor's other quests, for the dedup stage (`#694`).
   *
   * **Only that sponsor's.** Two sponsors asking similar things is a market
   * working; one sponsor asking the same thing twice is a mistake or an attempt
   * to have one piece of work paid for at two prices. Empty is the ordinary
   * answer for a first quest, and it skips the stage rather than asking a model
   * to compare against nothing.
   */
  siblings(taskId: PendingQuest['id']): Promise<readonly SponsorQuest[]>
}

export interface QuestLoopDependencies {
  readonly store: QuestModerationStore
  readonly model: Model
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/** What one quest's moderation came to. `failed` costs that quest a poll and nothing else. */
export type QuestJudgement =
  | { readonly kind: 'approved'; readonly published: QuestPublishOutcome }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * Judge one quest's text, and act on the verdict.
 *
 * **Four stages, each with its own outcome, and the order is the report
 * pipeline's for the report pipeline's reasons** (`#694`). Every stage costs a
 * model call and every stage is an exit, so the cheapest and most severe goes
 * first: a quest that crosses a red line is refused without paying for the three
 * behind it, and it is refused regardless of how well written it is — an
 * articulate instruction to defeat a captcha must not survive because it cleared
 * a quality bar.
 *
 * Dedup is last because it is the only stage whose answer depends on something
 * other than this text, and reading the sponsor's other quests to compare
 * against a brief that was never going to be published is the one wasted read
 * available here.
 *
 * **Four calls rather than one structured answer.** The record already holds
 * four outcomes in four vocabularies — `ModerationStageSchema` refuses to
 * normalise them precisely so a reader can recover which question was asked —
 * and one call answering all four would have to be re-run in full to change any
 * of them. It is also what `loop.ts` does for a citizen's report, one file away.
 *
 * **A stage that did not run says so.** `noStagesRun` starts all four at
 * `not-run` and each fills in its own, so a quest refused on a red line records
 * that quality, confidentiality and dedup were never reached — rather than
 * recording nothing about them, which would make *the quality check passed it*
 * and *the quality check never looked* the same row.
 *
 * **A model that is unreachable leaves the quest in `pending_review`.** Not
 * approved, not refused, and retried on the next tick. This is the clause the
 * whole design rests on and it holds for every failure this function can have,
 * not only an unreachable model: a timeout, a malformed answer, a throw between
 * the verdict and the publication. An outage must never publish, and must never
 * turn away a sponsor who did nothing wrong. Nothing is recorded until every
 * stage that was going to run has run, so a failure part-way through leaves no
 * half-verdict behind.
 *
 * **The refusal is written by `record` and not by a second call.** Rejecting is
 * part of the transaction that stores the verdict — see `recordQuestModeration`
 * — so a refused quest cannot exist as a verdict nothing acted on. Publication
 * has no such transaction available to it, which is what
 * {@link QuestModerationStore.cleared} is for.
 */
export async function judgeQuest(
  quest: PendingQuest,
  deps: QuestLoopDependencies,
): Promise<QuestJudgement> {
  const { store, model, log = silentLog } = deps

  /** The brief as every stage reads it. One shape, so no stage sees a different quest. */
  const brief = [
    `Title: ${quest.title}`,
    '',
    `Description: ${quest.description}`,
    '',
    'Instructions to the citizen:',
    quest.instructions,
  ].join('\n')

  try {
    const stages = noStagesRun()
    /**
     * Which model actually answered, taken from the last call that reported one.
     *
     * Configuration says what was asked for and the reply says what did it — the
     * distinction `ModelCall` exists to keep. All four calls go to the same
     * client, so the last answer is as true as the first and needs no reconciling.
     */
    let answeredBy = model.name

    const redLine = await model.classify({
      system: QUEST_RED_LINE_PROMPT,
      user: brief,
      choices: ['clear', 'crossed'],
    })
    answeredBy = redLine.call?.model ?? answeredBy

    if (redLine.decision === 'crossed') {
      // **The reason is recorded and not shown.** `#694`'s second register: a
      // red-line refusal names no rule and no phrase, because every specific
      // refusal teaches somebody probing where the boundary is.
      stages.redLine = { outcome: 'crossed', reason: redLine.reason }
      return await refuse(quest, deps, stages, answeredBy, redLineRefusal(), redLine.reason)
    }
    stages.redLine = { outcome: 'clear' }

    const quality = await model.classify({
      system: QUEST_QUALITY_PROMPT,
      user: brief,
      choices: ['answerable', 'unanswerable'],
    })
    answeredBy = quality.call?.model ?? answeredBy

    if (quality.decision === 'unanswerable') {
      stages.quality = { outcome: 'unanswerable', reason: quality.reason }
      return await refuse(
        quest,
        deps,
        stages,
        answeredBy,
        correctableRefusal(quality.reason),
        quality.reason,
      )
    }
    stages.quality = { outcome: 'answerable' }

    const confidentiality = await model.classify({
      system: QUEST_CONFIDENTIALITY_PROMPT,
      user: brief,
      choices: ['clean', 'overreaching'],
    })
    answeredBy = confidentiality.call?.model ?? answeredBy

    if (confidentiality.decision === 'overreaching') {
      stages.confidentiality = { outcome: 'overreaching', reason: confidentiality.reason }
      return await refuse(
        quest,
        deps,
        stages,
        answeredBy,
        correctableRefusal(confidentiality.reason),
        confidentiality.reason,
      )
    }
    stages.confidentiality = { outcome: 'clean' }

    /**
     * **No siblings means nothing to be a duplicate of**, and the stage is
     * skipped rather than asked. A model handed an empty comparison set answers
     * from the brief alone, which is the shape of an accident; `not-run` is the
     * honest record and it saves a call on every first quest a sponsor writes.
     */
    const siblings = await store.siblings(quest.id)
    if (siblings.length > 0) {
      const dedup = await model.classify({
        system: QUEST_DEDUP_PROMPT,
        user: [
          brief,
          '',
          `The same sponsor's other tasks (${siblings.length}):`,
          ...siblings.map((one) => `- ${one.title}: ${one.description}`),
        ].join('\n'),
        choices: ['distinct', 'duplicate'],
      })
      answeredBy = dedup.call?.model ?? answeredBy

      if (dedup.decision === 'duplicate') {
        stages.dedup = { outcome: 'duplicate', reason: dedup.reason }
        return await refuse(
          quest,
          deps,
          stages,
          answeredBy,
          correctableRefusal(dedup.reason),
          dedup.reason,
        )
      }
      stages.dedup = { outcome: 'distinct' }
    }

    const written = await store.record({
      taskId: quest.id,
      decision: 'approved',
      model: answeredBy,
      stages,
      judged: {
        title: quest.title,
        description: quest.description,
        instructions: quest.instructions,
      },
    })

    if (written.outcome === 'stale') return { kind: 'stale' }

    return { kind: 'approved', published: await store.publish(quest.id) }
  } catch (error) {
    log.error(`could not moderate quest ${quest.id}`, error, {
      event: 'quest.moderate.failed',
      questId: quest.id,
    })
    return { kind: 'failed', error }
  }
}

/**
 * Record a refusal, with what the sponsor reads and what the Colony keeps.
 *
 * **Two sentences and they are not the same one** (`#694`). `told` goes onto the
 * task where the sponsor reads it; `reason` is the model's own and goes into
 * `stages`, which is what answers *why was this refused* months later. For three
 * of the four stages they say the same thing; for the red line they deliberately
 * do not.
 */
async function refuse(
  quest: PendingQuest,
  deps: QuestLoopDependencies,
  stages: ModerationStages,
  model: string,
  told: string,
  reason: string,
): Promise<QuestJudgement> {
  const written = await deps.store.record({
    taskId: quest.id,
    decision: 'rejected',
    reason: told,
    model,
    stages,
    judged: {
      title: quest.title,
      description: quest.description,
      instructions: quest.instructions,
    },
  })

  return written.outcome === 'stale' ? { kind: 'stale' } : { kind: 'rejected', reason }
}

/** What one pass over the quest queue came to. */
export interface QuestTickOutcome {
  readonly judged: number
  readonly approved: number
  readonly rejected: number
  readonly failed: number
  /**
   * How many quests this pass actually put in front of citizens (`#693`).
   *
   * **Distinct from `approved`, and the gap is the thing worth watching.** A
   * quest can clear moderation and still not publish — the audit brake, an
   * entry with no walkable recipe, a text that moved underneath the verdict —
   * and a runner that reported only `approved` would say the sponsor was
   * answered when it was not. Counts `awaiting-payment` too: a quest waiting
   * for its money has been published as far as this stage is concerned.
   */
  readonly published: number
  /** Quests released from a verdict an earlier pass recorded and did not act on. */
  readonly released: number
}

/**
 * Take one batch of unjudged quests through the stage.
 *
 * Sequential like `tick`, though for a weaker reason: nothing here is
 * order-dependent, because a quest is judged against the Colony's rules and
 * never against the other quests. What it shares is that this process spends
 * money per row, and a burst of parallel calls is the shape of an accident.
 */
export async function questTick(
  deps: QuestLoopDependencies,
  batchSize: number,
): Promise<QuestTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = { judged: 0, approved: 0, rejected: 0, failed: 0, published: 0, released: 0 }

  /**
   * The retry first, and deliberately (`#693`).
   *
   * A quest stranded by an earlier pass has already waited a poll longer than
   * the ones in the queue behind it, and releasing it costs no model call — so
   * it goes before the judgements rather than after them, where a batch of
   * expensive calls would delay it again.
   */
  for (const taskId of await store.cleared(batchSize)) {
    try {
      const published = await store.publish(taskId)
      if (reachedCitizens(published)) outcome.released++
      log.info(`quest ${taskId} released from a verdict an earlier pass recorded`, {
        event: 'quest.released',
        questId: taskId,
        outcome: published.outcome,
      })
    } catch (error) {
      outcome.failed++
      log.error(`could not release quest ${taskId}`, error, {
        event: 'quest.release.failed',
        questId: taskId,
      })
    }
  }

  for (const quest of await store.pending(batchSize)) {
    const judgement = await judgeQuest(quest, deps)
    outcome.judged++

    switch (judgement.kind) {
      case 'approved':
        outcome.approved++
        if (reachedCitizens(judgement.published)) outcome.published++
        log.info(`quest ${quest.id} cleared moderation`, {
          event: 'quest.judged',
          questId: quest.id,
          verdict: 'cleared',
          // What the clearance actually did. `published` and `awaiting-payment`
          // are the two that answered the sponsor; anything else is a quest that
          // cleared the model and was stopped by something the model does not
          // judge, and it is the field to group by when asking why.
          published: judgement.published.outcome,
        })
        break
      case 'rejected':
        outcome.rejected++
        log.info(`quest ${quest.id} refused: ${judgement.reason}`, {
          event: 'quest.judged',
          questId: quest.id,
          verdict: 'refused',
        })
        break
      case 'stale':
        log.warn(`quest ${quest.id} had moved on when its verdict arrived`, {
          event: 'quest.stale',
          questId: quest.id,
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
 * Whether a publication attempt put the quest in front of citizens (`#693`).
 *
 * `awaiting-payment` counts: under D-106 a quest priced in SOL is published and
 * waiting for the sponsor's transfer, and the sponsor has its answer. Every
 * other outcome is a quest the model cleared and something else stopped, which
 * is the case the counters exist to keep visible rather than to hide inside
 * `approved`.
 */
function reachedCitizens(outcome: QuestPublishOutcome): boolean {
  return outcome.outcome === 'published' || outcome.outcome === 'awaiting-payment'
}
