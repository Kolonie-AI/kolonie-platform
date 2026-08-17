import { noStagesRun, type ModerationStages } from '@kolonie-ai/core'
import type { HeldQuest, PendingQuest, QuestPublishOutcome, SponsorQuest } from '@kolonie-ai/db'
import type { Log } from './loop.js'
import type { Model } from './llm.js'
import { fileFinding, noIssues, watchMarker, type IssueOpener } from './tripwire.js'
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
 * `kolonie.quests.end` takes a live quest down with a published reason, and
 * every use of it is filed as an issue a maintainer reads (`#944`). The second
 * reading of what this pass published is no longer a human's either: it runs
 * beside this one in `quest-audit.ts`, on the same poll.
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
   * Quests the Colony cleared and then stopped short of publishing (`#759`).
   *
   * **Disjoint from {@link QuestModerationStore.cleared} by construction**, and
   * that disjointness is the fix: a held quest left in `cleared` was re-picked
   * every fifteen seconds, publishing nothing and writing a log line each time,
   * so the one event worth seeing was buried under four an hour times however
   * long the hold ran. It moves here, where it is retried on a slow tick.
   */
  held(limit: number): Promise<readonly HeldQuest[]>
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
  /**
   * Where a hold that has run too long is filed (`#759`).
   *
   * The tripwire's opener, and for its reason: a hold is a defect in the
   * Colony's own configuration, so the maintainer who can lift it is not
   * reading the runner's logs. Absent degrades to {@link noIssues}, which is
   * what a runner with no token gets.
   */
  readonly issues?: IssueOpener
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
  /**
   * Quests this pass put on the hold rather than in front of citizens (`#759`).
   *
   * Counts the transition and not the state: a quest already held is not in
   * this pass's batch at all, so a hold that runs for a week contributes one.
   * The standing count is what {@link heldQuestTick} reports.
   */
  readonly held: number
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
  const outcome = {
    judged: 0,
    approved: 0,
    rejected: 0,
    failed: 0,
    published: 0,
    released: 0,
    held: 0,
  }

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
      if (published.outcome === 'audit-missing') {
        outcome.held++
        reportHold(log, taskId, published)
        continue
      }
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
        if (judgement.published.outcome === 'audit-missing') {
          outcome.held++
          reportHold(log, quest.id, judgement.published)
        }
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

/**
 * The one log line a hold is worth (`#759`).
 *
 * **Gated on the hold being new, which is the whole defect.** The audit brake
 * refuses cheaply and deterministically: a quest it stopped will be stopped
 * again on the next attempt and on every attempt until a maintainer changes
 * something, so a line per attempt is a line per fifteen seconds saying what the
 * first one said. A hold that is already recorded says nothing here — the
 * standing count belongs to {@link heldQuestTick}.
 */
function reportHold(
  log: Log,
  taskId: PendingQuest['id'],
  published: Extract<QuestPublishOutcome, { outcome: 'audit-missing' }>,
): void {
  if (!published.firstHold) return

  log.warn(`quest ${taskId} cleared moderation and is held short of publication`, {
    event: 'quest.held',
    questId: taskId,
    reason: published.reason,
    heldSince: published.heldSince,
  })
}

/**
 * How long a hold may run before a maintainer is told in a channel they read.
 *
 * **Hours rather than minutes**, because the brake is also the ordinary shape of
 * a deploy that has not finished: a runner started before its audit
 * configuration lands holds every quest it clears until the configuration does,
 * and an issue per quest in that window is noise about a state that fixes
 * itself. Long enough that a hold reaching it is a hold nobody is fixing.
 */
export const HELD_QUEST_ALERT_HOURS = 6

/** What one sweep over the held quests came to. */
export interface HeldQuestTickOutcome {
  /** Quests still held after the sweep — the standing count, not a transition. */
  readonly held: number
  /** Quests the retry got published. */
  readonly released: number
  /** Held quests that reached {@link HELD_QUEST_ALERT_HOURS} and had an issue filed. */
  readonly alerted: number
  readonly failed: number
}

/**
 * Retry the held quests, and file the ones nobody is lifting (`#759`).
 *
 * **On its own slow tick, and that is the point.** The audit brake is not a
 * transient failure — nothing about waiting makes an unconfigured audit
 * configured — so retrying it at the queue's own fifteen seconds spends a
 * database round trip per quest per tick to learn what the previous tick learnt.
 * What a retry is for is the case where a maintainer *has* fixed it: the hold
 * lifts on its own within the hour rather than waiting for the sponsor to notice
 * and ask.
 *
 * **The issue is the escalation, because a log line is not one.** A hold is
 * invisible to the sponsor by design and invisible to the maintainer in
 * practice; `AGENTS.md` §6 step 7 says a finding that would otherwise be
 * rediscovered belongs in an issue now, and a quest paid for and not published is
 * that finding.
 */
export async function heldQuestTick(
  deps: QuestLoopDependencies,
  batchSize: number,
  at: string = new Date().toISOString(),
): Promise<HeldQuestTickOutcome> {
  const { store, log = silentLog, issues = noIssues } = deps
  const outcome = { held: 0, released: 0, alerted: 0, failed: 0 }

  for (const quest of await store.held(batchSize)) {
    try {
      const published = await store.publish(quest.id)

      if (published.outcome !== 'audit-missing') {
        outcome.released++
        log.info(`quest ${quest.id} published after a hold that has now lifted`, {
          event: 'quest.hold.lifted',
          questId: quest.id,
          outcome: published.outcome,
          heldSince: quest.heldSince,
        })
        continue
      }

      outcome.held++
      if (await fileHeldQuest(quest, at, issues, log)) outcome.alerted++
    } catch (error) {
      outcome.failed++
      log.error(`could not retry held quest ${quest.id}`, error, {
        event: 'quest.hold.retry.failed',
        questId: quest.id,
      })
    }
  }

  return outcome
}

/** One marker per quest: two quests held is two findings, not one. */
export function heldQuestMarker(questId: string): string {
  return watchMarker(`quest-held:${questId}`)
}

/**
 * Whether this sweep filed an issue about the hold.
 *
 * **No recurrence line, deliberately** (`#1161`). The slow tick re-measures the
 * same hold every hour and the hours in the title are the only thing that
 * changes; a comment each time would be `#231`'s wallpaper, which the debt
 * watcher in the other runner already refuses to write. A hold that is *still*
 * held after a maintainer closed the issue is a different matter, and
 * {@link fileFinding} reopens it — the configuration was not fixed, and the
 * sponsor's money is still committed.
 */
async function fileHeldQuest(
  quest: HeldQuest,
  at: string,
  issues: IssueOpener,
  log: Log,
): Promise<boolean> {
  const hours = (Date.parse(at) - Date.parse(quest.heldSince)) / 3_600_000
  if (!Number.isFinite(hours) || hours < HELD_QUEST_ALERT_HOURS) return false

  const outcome = await fileFinding(
    issues,
    {
      marker: heldQuestMarker(quest.id),
      title: `Quest ${quest.id} has been held short of publication for ${Math.floor(hours)}h`,
      body: heldQuestIssueBody(quest, Math.floor(hours)),
      kind: 'standing',
    },
    log,
    { opened: 'quest.hold.issue.opened', recurred: 'quest.hold.issue.recurred' },
  )

  return outcome.action === 'opened' || outcome.action === 'reopened'
}

/**
 * What the automated issue says.
 *
 * **No sponsor text and no quest text**, on the tripwire's rule: every value here
 * is an id, a count or a timestamp this function was handed. The title is what a
 * maintainer scans; what dedups the next sweep is {@link heldQuestMarker} on the
 * first line, which {@link fileFinding} puts there.
 */
export function heldQuestIssueBody(quest: HeldQuest, hours: number): string {
  return [
    `Quest \`${quest.id}\` cleared moderation and has not been published since ` +
      `${quest.heldSince} — ${hours} hours, against a bar of ${HELD_QUEST_ALERT_HOURS}. ` +
      'The sponsor committed its money at submission and is told the quest is held, not why.',
    '',
    'The brake is the audit policy: publication is refused when the deployment has not ' +
      'configured what a paid quest is audited against. Nothing about waiting fixes that, so ' +
      'this will not lift on its own. Check the audit variables on the runner and on the API — ' +
      'they are read by both and default to *off*, which refuses rather than publishes ' +
      'unguarded.',
    '',
    'Opened automatically by the quest stage in `apps/moderation-runner`. The hold lifts by ' +
      'itself once the configuration is right: the sweep retries every held quest on its slow ' +
      'tick and publishes the ones that now clear.',
  ].join('\n')
}
