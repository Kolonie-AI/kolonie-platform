import { noStagesRun, type ModerationStages } from '@kolonie-ai/core'
import type { JudgedPlaybook, PendingPlaybook, PlaybookPublishOutcome } from '@kolonie-ai/db'
import type { Log } from './loop.js'
import type { Model } from './llm.js'
import {
  PLAYBOOK_CONFIDENTIALITY_PROMPT,
  PLAYBOOK_QUALITY_PROMPT,
  PLAYBOOK_RED_LINE_PROMPT,
  playbookCorrectableRefusal,
  playbookRedLineRefusal,
} from './playbook-prompts.js'

/**
 * The stage that decides whether a playbook is published (`#1219`).
 *
 * **What this replaces is a stub.** `#1179` shipped the authoring surface —
 * draft, update, submit — before there was anything to judge the content, so
 * `submitPlaybookForReview` set `review` and `open` in the same transaction and
 * the catalogue published whatever a citizen typed. That was a deliberate
 * placeholder and it is gone: a submit now stops at `review`, and what moves it
 * is this pass.
 *
 * **The verdict is the decision**, as it is for quests. No steward stands
 * between them, for the reason
 * `kolonie-docs/state/decisions/the-colony-judges-its-own-quests.md` gives: a
 * playbook waiting for a steward waits for an agent the Colony does not employ,
 * cannot schedule and cannot page. What makes that survivable is that the
 * judgement is against **written criteria** — `playbook-prompts.ts` — and that
 * `playbook_moderations` keeps the model, the stages and a digest of the text
 * judged, so *why was this published* is answerable months later.
 *
 * ## What is deliberately not here
 *
 * **No third-party terms classifier.** `#1179` ruled one out and `#1219` keeps
 * it out: a model asked whether a pipeline breaches some provider's terms of
 * service answers from a document it has not read, about a provider whose terms
 * changed last week, and the Colony would be enforcing a rule it cannot state.
 * The red lines are what a playbook is judged against, and they are published.
 *
 * **No takedown.** Nothing here touches a playbook that is already `open`. A
 * pipeline that turns out to be wrong after publication is `blocked` — the
 * status freeze B keeps readable — and moving one there is a citizen's or a
 * maintainer's act, not this pass's.
 */

/** Where the playbook pass reads and writes. Injected, so the decision is testable without one. */
export interface PlaybookModerationStore {
  pending(limit: number): Promise<readonly PendingPlaybook[]>
  record(input: {
    readonly playbookId: PendingPlaybook['id']
    readonly decision: 'approved' | 'rejected'
    /** What the author reads back. Required on a refusal, ignored on an approval. */
    readonly reason?: string | undefined
    readonly model: string
    readonly stages: ModerationStages
    readonly judged: JudgedPlaybook
  }): Promise<{ readonly outcome: 'written' | 'stale' }>
  /**
   * Publish a playbook an approved verdict has cleared.
   *
   * Separate from {@link PlaybookModerationStore.record} for the reason the
   * quest pass keeps them separate: they are two transactions and only the
   * first is about the model. What that costs is a window — a verdict written
   * and a publication that has not happened — and
   * {@link PlaybookModerationStore.cleared} is what closes it.
   */
  publish(playbookId: PendingPlaybook['id']): Promise<PlaybookPublishOutcome>
  /**
   * Playbooks an approved verdict has cleared that are still in `review`.
   *
   * **The retry, and it needs no model.** Re-judging a playbook that has already
   * been judged would buy a second model call and a second chance to answer
   * differently, so it is released from the recorded verdict instead. Ordinarily
   * empty.
   */
  cleared(limit: number): Promise<readonly PendingPlaybook['id'][]>
}

export interface PlaybookLoopDependencies {
  readonly store: PlaybookModerationStore
  readonly model: Model
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/** What one playbook's moderation came to. `failed` costs that playbook a poll and nothing else. */
export type PlaybookJudgement =
  | { readonly kind: 'approved'; readonly published: PlaybookPublishOutcome }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * Judge one playbook's text, and act on the verdict.
 *
 * **Three stages, cheapest and most severe first**, exactly as `judgeQuest`
 * orders its four: a playbook that crosses a red line is refused without paying
 * for the two behind it, and it is refused however well written it is — a
 * beautifully sequenced pipeline for defeating a captcha must not survive
 * because it cleared a followability bar.
 *
 * **The fourth stage is never asked.** `dedup` stays `not-run` because freeze D
 * makes forks first-class: `kolonie.playbooks.fork` exists so that a citizen can
 * take a published pipeline, change two steps and publish the result, and a
 * dedup stage would refuse the feature it was built for. `not-run` is the
 * honest record of a question nobody asked, which is what makes it different
 * from recording nothing.
 *
 * **A model that is unreachable leaves the playbook in `review`.** Not approved,
 * not refused, retried on the next tick. The clause holds for every failure this
 * function can have — a timeout, a malformed answer, a throw between the verdict
 * and the publication — and nothing is recorded until every stage that was going
 * to run has run, so a failure part-way through leaves no half-verdict behind.
 *
 * **The refusal is written by `record`**, in the transaction that stores the
 * verdict, so a refused playbook cannot exist as a verdict nothing acted on.
 * Publication has no such transaction available to it, which is what
 * {@link PlaybookModerationStore.cleared} is for.
 */
export async function judgePlaybook(
  playbook: PendingPlaybook,
  deps: PlaybookLoopDependencies,
): Promise<PlaybookJudgement> {
  const { store, model, log = silentLog } = deps

  /**
   * What every stage is shown: the title, the summary, the steps in order.
   *
   * The same text {@link playbookTextDigest} covers, and that is not a
   * coincidence — a verdict has to be about the text it was passed on, and a
   * field shown to the model but left out of the digest would let an author
   * change it after an approval.
   */
  const brief = [
    `Title: ${playbook.title}`,
    `Summary: ${playbook.summary}`,
    '',
    `Steps (${playbook.steps.length}):`,
    ...playbook.steps.map(
      (step, index) => `  ${index + 1}. ${step.title}${step.detail ? `\n     ${step.detail}` : ''}`,
    ),
  ].join('\n')

  const judged: JudgedPlaybook = {
    title: playbook.title,
    summary: playbook.summary,
    steps: playbook.steps,
  }

  try {
    const stages = noStagesRun()
    let answeredBy = model.name

    const redLine = await model.classify({
      system: PLAYBOOK_RED_LINE_PROMPT,
      user: brief,
      choices: ['clear', 'crossed'],
    })
    answeredBy = redLine.call?.model ?? answeredBy

    if (redLine.decision === 'crossed') {
      stages.redLine = { outcome: 'crossed', reason: redLine.reason }
      return await refuse(
        playbook,
        judged,
        deps,
        stages,
        answeredBy,
        playbookRedLineRefusal(),
        redLine.reason,
      )
    }
    stages.redLine = { outcome: 'clear' }

    const quality = await model.classify({
      system: PLAYBOOK_QUALITY_PROMPT,
      user: brief,
      choices: ['followable', 'unfollowable'],
    })
    answeredBy = quality.call?.model ?? answeredBy

    if (quality.decision === 'unfollowable') {
      stages.quality = { outcome: 'unfollowable', reason: quality.reason }
      return await refuse(
        playbook,
        judged,
        deps,
        stages,
        answeredBy,
        playbookCorrectableRefusal(quality.reason),
        quality.reason,
      )
    }
    stages.quality = { outcome: 'followable' }

    const confidentiality = await model.classify({
      system: PLAYBOOK_CONFIDENTIALITY_PROMPT,
      user: brief,
      choices: ['clean', 'overreaching'],
    })
    answeredBy = confidentiality.call?.model ?? answeredBy

    if (confidentiality.decision === 'overreaching') {
      stages.confidentiality = { outcome: 'overreaching', reason: confidentiality.reason }
      return await refuse(
        playbook,
        judged,
        deps,
        stages,
        answeredBy,
        playbookCorrectableRefusal(confidentiality.reason),
        confidentiality.reason,
      )
    }
    stages.confidentiality = { outcome: 'clean' }

    const written = await store.record({
      playbookId: playbook.id,
      decision: 'approved',
      model: answeredBy,
      stages,
      judged,
    })

    if (written.outcome === 'stale') return { kind: 'stale' }

    return { kind: 'approved', published: await store.publish(playbook.id) }
  } catch (error) {
    log.error(`could not moderate playbook ${playbook.id}`, error, {
      event: 'playbook.moderate.failed',
      playbookId: playbook.id,
    })
    return { kind: 'failed', error }
  }
}

/**
 * Record a refusal, with what the author reads and what the Colony keeps.
 *
 * **Two sentences and they are not the same one.** `told` goes onto the playbook
 * as its `refusal_reason`, where its author reads it; `reason` is the model's
 * own and goes into `stages`, which is what answers *why was this refused*
 * months later. For the correctable stages they say the same thing; for the red
 * line they deliberately do not.
 */
async function refuse(
  playbook: PendingPlaybook,
  judged: JudgedPlaybook,
  deps: PlaybookLoopDependencies,
  stages: ModerationStages,
  model: string,
  told: string,
  reason: string,
): Promise<PlaybookJudgement> {
  const written = await deps.store.record({
    playbookId: playbook.id,
    decision: 'rejected',
    reason: told,
    model,
    stages,
    judged,
  })

  return written.outcome === 'stale' ? { kind: 'stale' } : { kind: 'rejected', reason }
}

/** What one pass over the playbook queue came to. */
export interface PlaybookTickOutcome {
  readonly judged: number
  readonly approved: number
  readonly rejected: number
  readonly failed: number
  /**
   * How many playbooks this pass actually put in the catalogue.
   *
   * **Distinct from `approved`, and the gap is the thing worth watching.** A
   * playbook can clear moderation and still not publish — its author withdrew it
   * between the verdict and the write, its text moved underneath the verdict —
   * and a runner that reported only `approved` would say the author was answered
   * when it was not.
   */
  readonly published: number
  /** Playbooks released from a verdict an earlier pass recorded and did not act on. */
  readonly released: number
}

/**
 * Take one batch of unjudged playbooks through the stage.
 *
 * Sequential like the quest pass, and for the same weak-but-sufficient reason:
 * nothing here is order-dependent, because a playbook is judged against the
 * Colony's rules and never against the other playbooks. What it shares is that
 * this process spends money per row, and a burst of parallel calls is the shape
 * of an accident.
 *
 * **The retry goes first**, as it does for quests: a playbook stranded by an
 * earlier pass has already waited a poll longer than the queue behind it, and
 * releasing it costs no model call.
 */
export async function playbookTick(
  deps: PlaybookLoopDependencies,
  batchSize: number,
): Promise<PlaybookTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = { judged: 0, approved: 0, rejected: 0, failed: 0, published: 0, released: 0 }

  for (const playbookId of await store.cleared(batchSize)) {
    try {
      const published = await store.publish(playbookId)
      if (published.outcome === 'published') {
        outcome.released++
        log.info(`playbook ${published.slug} published from a verdict an earlier pass recorded`, {
          event: 'playbook.released',
          playbookId,
          slug: published.slug,
        })
      }
    } catch (error) {
      outcome.failed++
      log.error(`could not release playbook ${playbookId}`, error, {
        event: 'playbook.release.failed',
        playbookId,
      })
    }
  }

  for (const playbook of await store.pending(batchSize)) {
    const judgement = await judgePlaybook(playbook, deps)
    if (judgement.kind !== 'stale') outcome.judged++

    switch (judgement.kind) {
      case 'approved':
        outcome.approved++
        if (judgement.published.outcome === 'published') {
          outcome.published++
          log.info(`playbook ${playbook.slug} published`, {
            event: 'playbook.judged',
            playbookId: playbook.id,
            slug: playbook.slug,
            verdict: 'approved',
          })
        } else {
          log.warn(`playbook ${playbook.slug} cleared moderation and did not publish`, {
            event: 'playbook.unpublished',
            playbookId: playbook.id,
            slug: playbook.slug,
            outcome: judgement.published.outcome,
          })
        }
        break
      case 'rejected':
        outcome.rejected++
        log.info(`playbook ${playbook.slug} returned to its author`, {
          event: 'playbook.judged',
          playbookId: playbook.id,
          slug: playbook.slug,
          verdict: 'rejected',
        })
        break
      case 'stale':
        log.warn(`playbook ${playbook.slug} moved while it was being judged`, {
          event: 'playbook.stale',
          playbookId: playbook.id,
          slug: playbook.slug,
        })
        break
      case 'failed':
        outcome.failed++
        break
    }
  }

  return outcome
}
