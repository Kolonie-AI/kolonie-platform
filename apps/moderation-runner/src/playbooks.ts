import {
  ConfidentialSpanKindSchema,
  GUIDANCE_CONTENT_MIN_LENGTH,
  noStagesRun,
  PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH,
  type ModerationStages,
} from '@kolonie-ai/core'
import type {
  JudgedPlaybook,
  PendingPlaybook,
  PendingPlaybookNote,
  PendingPlaybookStepProposal,
  PlaybookPublishOutcome,
  RecordPlaybookNoteVerdictInput,
  RecordPlaybookStepProposalVerdictInput,
} from '@kolonie-ai/db'
import { redact, REDACTION } from './answers.js'
import { CONFIDENTIALITY_PROMPT } from './confidentiality.js'
import type { Log } from './loop.js'
import type { Model } from './llm.js'
import { judgePlaybookNoteQuality } from './quality.js'
import { RED_LINE_PROMPT } from './redline.js'
import {
  PLAYBOOK_CONFIDENTIALITY_PROMPT,
  PLAYBOOK_QUALITY_PROMPT,
  PLAYBOOK_RED_LINE_PROMPT,
  PLAYBOOK_STEP_COHERENCE_PROMPT,
  PLAYBOOK_STEP_MERIT_PROMPT,
  playbookCorrectableRefusal,
  playbookRedLineRefusal,
  playbookStepProposalRedLineRefusal,
  playbookStepProposalRefusal,
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

/**
 * The stage that decides whether a run note is published (`#1246`).
 *
 * **A second pass on this file rather than a second file, because it is the same
 * queue read twice.** `playbookTick` judges a pipeline before anybody may run
 * it; this judges one sentence somebody wrote after running it. What they share
 * is the subject — a reader deciding whether to run a playbook reads both — and
 * sharing a module is what keeps the two verdicts legible side by side.
 *
 * ## Three judgements, cheapest refusal that is also the most serious first
 *
 * Red lines, then the scrub, then quality. The order is `#1246`'s and it is not
 * an optimisation: a note that tells its reader to paste an API key is refused
 * for that and never for being thin, so the most serious question is asked while
 * it can still be the answer.
 *
 * ## The moderator cuts and cannot write
 *
 * `#1246` allows an approved note to be shortened, and forbids adding a claim
 * its author did not make. Only one construction enforces the second rather than
 * asking a model to honour it, so that is the one here: the published text is
 * the author's text with its confidential spans redacted and, where that pushed
 * it past the bound, cut at a sentence boundary. Every character published came
 * from {@link PendingPlaybookNote.note}. There is no rewrite step and
 * {@link Model} exposes no shape that could hold one.
 *
 * ## Why a refusal costs the author nothing
 *
 * The report stands, the four answers stand, and the reputation `#1177` paid
 * stands. A punished report is a report nobody files, and the note is the
 * optional part of it — what a rejection removes is the sentence, and it leaves
 * the author a reason to read.
 */

/** One note's queue, from the runner's side. Injected, like every store here. */
export interface PlaybookNoteModerationStore {
  pending(limit: number): Promise<readonly PendingPlaybookNote[]>
  record(input: RecordPlaybookNoteVerdictInput): Promise<{ readonly outcome: 'written' | 'stale' }>
}

export interface PlaybookNoteLoopDependencies {
  readonly store: PlaybookNoteModerationStore
  readonly model: Model
  readonly log?: Log
}

/** What one note's pass came to. */
export type PlaybookNoteJudgement =
  | { readonly kind: 'approved'; readonly published: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * What the note bound is measured against once the scrub has run.
 *
 * The redaction marker is nine characters and the handle it replaces may be
 * three, so a note that arrived inside the bound can leave the scrub outside it.
 * That is the only way a stored note can exceed
 * {@link PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH}, and it is why the shortening
 * runs after the scrub rather than instead of it.
 */
const SENTENCE_END = /[.!?](?=\s|$)/g

/**
 * Cut text to the bound at a boundary a reader will not notice, or refuse it.
 *
 * Sentence boundaries first, because a note cut mid-clause reads as a truncation
 * bug rather than as an edit; a word boundary second, for the note that is one
 * long sentence; and `undefined` when what survives is under
 * {@link GUIDANCE_CONTENT_MIN_LENGTH}, which is `#1246`'s *if nothing survives
 * the scrub it is rejected* — a note whose remaining text is four words is a
 * note with nothing left to act on, and publishing it under its author's handle
 * would attribute a fragment nobody wrote.
 *
 * **The two bounds measure two different strings, deliberately.** The maximum is
 * measured on the text as it will be stored, markers and all, because that is
 * what a reader receives and what the column check counts. The minimum is
 * measured with the markers taken out, because they are the moderator's
 * characters and not the author's: a note that scrubbed down to
 * `[removed] — [removed].` is twenty-two characters of nothing, and a survival
 * test that counted them would publish it.
 *
 * **No ellipsis and no marker for the cut.** A cut that announces itself invites
 * the reader to ask what was taken out, and the answer is either confidential or
 * nothing.
 */
export function shortenToBound(text: string): string | undefined {
  const survives = (kept: string) =>
    kept.split(REDACTION).join(' ').trim().length >= GUIDANCE_CONTENT_MIN_LENGTH

  const trimmed = text.trim()
  if (trimmed.length <= PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH) {
    return survives(trimmed) ? trimmed : undefined
  }

  const window = trimmed.slice(0, PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH)

  let sentence = -1
  for (const match of window.matchAll(SENTENCE_END)) sentence = match.index + 1
  const cut = sentence > 0 ? window.slice(0, sentence) : window.slice(0, window.lastIndexOf(' '))

  const kept = cut.trim()
  return survives(kept) ? kept : undefined
}

/**
 * Take one note through the three judgements and write the verdict.
 *
 * A failure writes nothing at all, which leaves the row `pending` for the next
 * pass — the `#170` direction, and the only handling consistent with having told
 * the author that filing a note costs it nothing.
 */
export async function judgePlaybookNote(
  entry: PendingPlaybookNote,
  deps: PlaybookNoteLoopDependencies,
): Promise<PlaybookNoteJudgement> {
  const { store, model, log = silentLog } = deps

  const refuse = async (reason: string): Promise<PlaybookNoteJudgement> => {
    const { outcome } = await store.record({
      runId: entry.runId,
      judged: entry.note,
      decision: 'rejected',
      reason,
    })
    return outcome === 'stale' ? { kind: 'stale' } : { kind: 'rejected', reason }
  }

  try {
    const redLine = await model.classify({
      system: RED_LINE_PROMPT,
      user: [`Playbook: ${entry.playbookTitle}`, '', entry.note].join('\n'),
      choices: ['clear', 'crossed'],
    })
    if (redLine.decision === 'crossed') return await refuse(redLine.reason)

    const spans = await model.mark({
      system: CONFIDENTIALITY_PROMPT,
      user: entry.note,
      kinds: ConfidentialSpanKindSchema.options,
    })

    /**
     * Only spans really in the note, for the reason the walk scrubber gives: a
     * model that paraphrases what it found would have the scrub replace a string
     * nobody wrote while leaving the one somebody did.
     */
    const present = [
      ...new Set(spans.map((span) => span.text).filter((text) => entry.note.includes(text))),
    ]

    const published = shortenToBound(redact(entry.note, present))
    if (published === undefined) return await refuse(NOTHING_SURVIVED_THE_SCRUB)

    const quality = await judgePlaybookNoteQuality(entry, published, model)
    if (quality.kind === 'useless') return await refuse(quality.reason)

    const { outcome } = await store.record({
      runId: entry.runId,
      judged: entry.note,
      decision: 'approved',
      published,
    })
    return outcome === 'stale' ? { kind: 'stale' } : { kind: 'approved', published }
  } catch (error) {
    log.error(`could not moderate the note on run ${entry.runId}`, error, {
      event: 'playbook.note.moderate.failed',
      runId: entry.runId,
      playbookId: entry.playbookId,
    })
    return { kind: 'failed', error }
  }
}

/**
 * What the author is told when the scrub took the note with it.
 *
 * Named because it is a verdict rather than a model's sentence — nothing wrote
 * it, so nothing may vary it — and because the author's next move is in it. A
 * note is not retried: re-filing the report is how it tries again.
 */
export const NOTHING_SURVIVED_THE_SCRUB = [
  'This note was mostly an address, a handle or a credential of your own, and what was left',
  'after taking those out was too short to publish. Re-file the report with a note that says',
  'what the next runner should know without naming an account.',
].join(' ')

/** What one pass over the note queue came to. */
export interface PlaybookNoteTickOutcome {
  readonly judged: number
  readonly approved: number
  readonly rejected: number
  readonly failed: number
}

/**
 * Take one batch of unjudged run notes through the stage.
 *
 * Sequential and oldest-first, for the reasons {@link playbookTick} gives: this
 * process spends money per row, and nothing here is order-dependent because a
 * note is judged against the Colony's rules and never against the other notes.
 */
export async function playbookNoteTick(
  deps: PlaybookNoteLoopDependencies,
  batchSize: number,
): Promise<PlaybookNoteTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = { judged: 0, approved: 0, rejected: 0, failed: 0 }

  for (const entry of await store.pending(batchSize)) {
    const judgement = await judgePlaybookNote(entry, deps)
    if (judgement.kind !== 'stale') outcome.judged++

    switch (judgement.kind) {
      case 'approved':
        outcome.approved++
        log.info(`the note on a run of ${entry.playbookTitle} was published`, {
          event: 'playbook.note.judged',
          runId: entry.runId,
          playbookId: entry.playbookId,
          verdict: 'approved',
        })
        break
      case 'rejected':
        outcome.rejected++
        log.info(`the note on a run of ${entry.playbookTitle} was returned to its author`, {
          event: 'playbook.note.judged',
          runId: entry.runId,
          playbookId: entry.playbookId,
          verdict: 'rejected',
        })
        break
      case 'stale':
        log.warn(`the note on run ${entry.runId} moved while it was being judged`, {
          event: 'playbook.note.stale',
          runId: entry.runId,
          playbookId: entry.playbookId,
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
 * Judging proposed changes to a published playbook's steps (`#1254`).
 *
 * A third pass on this file rather than a third file, for the same reason the
 * note pass shares it: one pipeline, three verdicts — publish the playbook,
 * publish a sentence about a run of it, accept a change to its steps — and
 * keeping them side by side is what keeps the four-stage order legible next to
 * the three-stage one above.
 *
 * ## Four judgements, cheapest refusal that is also the most serious first
 *
 * Red lines, then the scrub, then coherence, then merit. A proposal that asks
 * a reader to cross a red line is refused for that and never for being thin.
 *
 * ## The scrub refuses, it does not redact
 *
 * `#1254` is explicit: a credential, an address or a handle of the proposer's
 * own in the proposal is refused, not rewritten with markers. That is the one
 * place this pass diverges from {@link judgePlaybookNote}, where the scrub
 * redacts and publishes what survives.
 *
 * ## The moderator cuts and cannot write
 *
 * Same structural rule as a run note: every character that lands on an
 * accepted proposal came from the author. There is no rewrite step.
 *
 * ## Accepted proposals do not apply themselves
 *
 * They land in `accepted` and wait for `#1255` to fold them into a revision.
 * Sibling proposals at the same position become `superseded` in the same
 * write, so a later pass cannot re-judge them against a step already decided.
 */

/** How many proposals one cycle may judge. `#1254`'s bound; defensible, not measured. */
export const PLAYBOOK_PROPOSAL_BATCH = 100

/**
 * What the author is told when the scrub found a credential, address or handle.
 *
 * Named because it is a verdict rather than a model's sentence — nothing wrote
 * it, so nothing may vary it.
 */
export const A_PROPOSAL_NAMES_AN_ACCOUNT = [
  'This proposal names an address, a handle or a credential of your own, and a change to a',
  'pipeline cannot carry those. Re-file it without naming an account.',
].join(' ')

/**
 * What the author is told when the position is not a place in the pipeline.
 *
 * Deterministic: the model is not asked whether step 99 of a three-step
 * pipeline is real.
 */
export const A_PROPOSAL_POSITION_IS_UNREAL = [
  'This proposal points at a step that is not in the pipeline. Re-file it against a position',
  'that exists, or use insert-after with 0 for a new first step.',
].join(' ')

/** One proposal's queue, from the runner's side. */
export interface PlaybookProposalModerationStore {
  pending(limit: number): Promise<readonly PendingPlaybookStepProposal[]>
  record(
    input: RecordPlaybookStepProposalVerdictInput,
  ): Promise<{ readonly outcome: 'written' | 'stale'; readonly superseded: number }>
  /**
   * Briefing claims for one step position (`#1251`).
   *
   * Optional and empty until claim storage lands: merit treats absence as
   * context, never as a quorum, so an unwired reader is a real answer.
   */
  claimsFor?(
    playbookId: string,
    position: number,
  ): Promise<readonly { readonly section: string; readonly text: string }[]>
}

export interface PlaybookProposalLoopDependencies {
  readonly store: PlaybookProposalModerationStore
  readonly model: Model
  readonly log?: Log
}

/** What one proposal's pass came to. */
export type PlaybookProposalJudgement =
  | { readonly kind: 'accepted'; readonly superseded: number }
  | {
      readonly kind: 'rejected'
      readonly reason: string
      /** Seam for `#1260`: a red-line refusal is the abusive mark's input. */
      readonly redLine: boolean
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown }

/** The author's words the model reads, joined once for red lines and the scrub. */
const proposalProse = (entry: PendingPlaybookStepProposal): string =>
  [
    entry.title === null ? null : `Title: ${entry.title}`,
    entry.detail === null ? null : `Detail: ${entry.detail}`,
    `Why: ${entry.why}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')

/** Whether the position is a place a proposal of this kind may land. */
export function proposalPositionIsReal(
  kind: PendingPlaybookStepProposal['kind'],
  position: number,
  stepCount: number,
): boolean {
  if (kind === 'insert-after') return position >= 0 && position <= stepCount
  return position >= 1 && position <= stepCount
}

/** The current step the merit stage is shown, or a note that none is there. */
const currentStepBrief = (entry: PendingPlaybookStepProposal): string => {
  if (entry.kind === 'insert-after') {
    if (entry.position === 0)
      return 'There is no step there; this is an insertion as a new first step.'
    const after = entry.steps[entry.position - 1]
    return after === undefined
      ? `There is no step ${entry.position}; this is an insertion after a position past the end.`
      : `Inserting after step ${entry.position}: ${after.title}${after.detail ? `\n  ${after.detail}` : ''}`
  }
  const step = entry.steps[entry.position - 1]
  return step === undefined
    ? `There is no step ${entry.position} in this pipeline.`
    : `Current step ${entry.position}: ${step.title}${step.detail ? `\n  ${step.detail}` : ''}`
}

const coherenceUser = (entry: PendingPlaybookStepProposal): string => {
  const slots =
    entry.requiredAccounts.length === 0
      ? '  (none declared)'
      : entry.requiredAccounts
          .map((one) => `  - ${one.slot} (${one.kind}${one.provider ? ` @ ${one.provider}` : ''})`)
          .join('\n')

  return [
    `Playbook: ${entry.playbookTitle}`,
    `What it says it does: ${entry.playbookSummary}`,
    '',
    `Steps (${entry.steps.length}):`,
    ...entry.steps.map(
      (step, index) => `  ${index + 1}. ${step.title}${step.detail ? `\n     ${step.detail}` : ''}`,
    ),
    '',
    'Declared account slots:',
    slots,
    '',
    `Proposal kind: ${entry.kind}`,
    `Proposal position: ${entry.position}`,
    proposalProse(entry),
  ].join('\n')
}

const meritUser = (
  entry: PendingPlaybookStepProposal,
  claims: readonly { readonly section: string; readonly text: string }[],
): string => {
  const claimBlock =
    claims.length === 0
      ? 'What the Colony has gathered about this step: (none yet)'
      : [
          'What the Colony has gathered about this step:',
          ...claims.map((one) => `  - [${one.section}] ${one.text}`),
        ].join('\n')

  return [
    `Playbook: ${entry.playbookTitle}`,
    `What it says it does: ${entry.playbookSummary}`,
    '',
    currentStepBrief(entry),
    '',
    `Proposal kind: ${entry.kind}`,
    `Proposal position: ${entry.position}`,
    proposalProse(entry),
    '',
    claimBlock,
  ].join('\n')
}

/**
 * Take one proposal through the four judgements and write the verdict.
 *
 * A failure writes nothing at all, which leaves the row `pending` for the next
 * pass — the same `#170` direction the note path follows.
 */
export async function judgePlaybookStepProposal(
  entry: PendingPlaybookStepProposal,
  deps: PlaybookProposalLoopDependencies,
): Promise<PlaybookProposalJudgement> {
  const { store, model, log = silentLog } = deps

  const judged = {
    title: entry.title,
    detail: entry.detail,
    why: entry.why,
  }

  const refuse = async (reason: string, redLine = false): Promise<PlaybookProposalJudgement> => {
    const { outcome } = await store.record({
      proposalId: entry.proposalId,
      judged,
      decision: 'rejected',
      reason,
    })
    return outcome === 'stale' ? { kind: 'stale' } : { kind: 'rejected', reason, redLine }
  }

  try {
    const prose = proposalProse(entry)

    const redLine = await model.classify({
      system: RED_LINE_PROMPT,
      user: [`Playbook: ${entry.playbookTitle}`, '', prose].join('\n'),
      choices: ['clear', 'crossed'],
    })
    if (redLine.decision === 'crossed') {
      // `#1260` will count this as abusive; until then the refusal is the mark.
      log.info(`a step proposal on ${entry.playbookTitle} crossed a red line`, {
        event: 'playbook.proposal.abusive',
        proposalId: entry.proposalId,
        playbookId: entry.playbookId,
      })
      return await refuse(playbookStepProposalRedLineRefusal(), true)
    }

    const spans = await model.mark({
      system: CONFIDENTIALITY_PROMPT,
      user: prose,
      kinds: ConfidentialSpanKindSchema.options,
    })
    const present = [
      ...new Set(spans.map((span) => span.text).filter((text) => prose.includes(text))),
    ]
    if (present.length > 0) return await refuse(A_PROPOSAL_NAMES_AN_ACCOUNT)

    if (!proposalPositionIsReal(entry.kind, entry.position, entry.steps.length)) {
      return await refuse(A_PROPOSAL_POSITION_IS_UNREAL)
    }

    const coherence = await model.classify({
      system: PLAYBOOK_STEP_COHERENCE_PROMPT,
      user: coherenceUser(entry),
      choices: ['coherent', 'incoherent'],
    })
    if (coherence.decision === 'incoherent') {
      return await refuse(playbookStepProposalRefusal(coherence.reason))
    }

    const claims = store.claimsFor ? await store.claimsFor(entry.playbookId, entry.position) : []

    const merit = await model.classify({
      system: PLAYBOOK_STEP_MERIT_PROMPT,
      user: meritUser(entry, claims),
      choices: ['better', 'not-better'],
    })
    if (merit.decision === 'not-better') {
      return await refuse(playbookStepProposalRefusal(merit.reason))
    }

    const { outcome, superseded } = await store.record({
      proposalId: entry.proposalId,
      judged,
      decision: 'accepted',
      title: entry.title,
      detail: entry.detail,
      why: entry.why,
    })
    return outcome === 'stale' ? { kind: 'stale' } : { kind: 'accepted', superseded }
  } catch (error) {
    log.error(`could not moderate step proposal ${entry.proposalId}`, error, {
      event: 'playbook.proposal.moderate.failed',
      proposalId: entry.proposalId,
      playbookId: entry.playbookId,
    })
    return { kind: 'failed', error }
  }
}

/** What one pass over the proposal queue came to. */
export interface PlaybookProposalTickOutcome {
  readonly judged: number
  readonly accepted: number
  readonly rejected: number
  readonly superseded: number
  readonly failed: number
}

/**
 * Take one batch of unjudged step proposals through the stage.
 *
 * Sequential and oldest-first. Bounded by {@link PLAYBOOK_PROPOSAL_BATCH}
 * regardless of the runner's own batch size — `#1254`'s cost ceiling.
 */
export async function playbookProposalTick(
  deps: PlaybookProposalLoopDependencies,
  batchSize: number,
): Promise<PlaybookProposalTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = { judged: 0, accepted: 0, rejected: 0, superseded: 0, failed: 0 }
  const limit = Math.min(batchSize, PLAYBOOK_PROPOSAL_BATCH)

  for (const entry of await store.pending(limit)) {
    const judgement = await judgePlaybookStepProposal(entry, deps)
    if (judgement.kind !== 'stale') outcome.judged++

    switch (judgement.kind) {
      case 'accepted':
        outcome.accepted++
        outcome.superseded += judgement.superseded
        log.info(`a step proposal on ${entry.playbookTitle} was accepted`, {
          event: 'playbook.proposal.judged',
          proposalId: entry.proposalId,
          playbookId: entry.playbookId,
          verdict: 'accepted',
          superseded: judgement.superseded,
        })
        break
      case 'rejected':
        outcome.rejected++
        log.info(`a step proposal on ${entry.playbookTitle} was returned to its author`, {
          event: 'playbook.proposal.judged',
          proposalId: entry.proposalId,
          playbookId: entry.playbookId,
          verdict: 'rejected',
          redLine: judgement.redLine,
        })
        break
      case 'stale':
        log.warn(`step proposal ${entry.proposalId} moved while it was being judged`, {
          event: 'playbook.proposal.stale',
          proposalId: entry.proposalId,
          playbookId: entry.playbookId,
        })
        break
      case 'failed':
        outcome.failed++
        break
    }
  }

  return outcome
}

/** How many playbooks one cycle may fold. Same bound as the proposal batch. */
export const PLAYBOOK_REVISION_BATCH = 100

/**
 * What the fold tick needs from storage (`#1255`).
 *
 * No model: folding accepted proposals is deterministic. The store names the
 * playbooks waiting and cuts one revision each.
 */
export interface PlaybookRevisionModerationStore {
  waiting(limit: number): Promise<readonly string[]>
  cut(playbookId: string): Promise<{
    readonly outcome: 'cut' | 'incoherent' | 'nothing-to-fold' | 'unknown-playbook'
    readonly folded?: number
    readonly returned?: number
    readonly reason?: string
    readonly revision?: number
  }>
}

export interface PlaybookRevisionLoopDependencies {
  readonly store: PlaybookRevisionModerationStore
  readonly log?: Log
}

export interface PlaybookRevisionTickOutcome {
  readonly considered: number
  readonly cut: number
  readonly incoherent: number
  readonly folded: number
  readonly returned: number
  readonly empty: number
}

/**
 * Fold accepted, unfolded proposals into revisions (`#1255`).
 *
 * Runs after the proposal tick so a proposal accepted this cycle can fold in
 * the same pass. One cut per playbook per call — every accepted-unfolded
 * proposal on that playbook goes into one revision, in filing order.
 */
export async function playbookRevisionTick(
  deps: PlaybookRevisionLoopDependencies,
  batchSize: number,
): Promise<PlaybookRevisionTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = {
    considered: 0,
    cut: 0,
    incoherent: 0,
    folded: 0,
    returned: 0,
    empty: 0,
  }
  const limit = Math.min(batchSize, PLAYBOOK_REVISION_BATCH)

  for (const playbookId of await store.waiting(limit)) {
    outcome.considered++
    const result = await store.cut(playbookId)
    switch (result.outcome) {
      case 'cut':
        outcome.cut++
        outcome.folded += result.folded ?? 0
        log.info(`folded ${result.folded ?? 0} proposals into revision ${result.revision}`, {
          event: 'playbook.revision.cut',
          playbookId,
          revision: result.revision,
          folded: result.folded,
        })
        break
      case 'incoherent':
        outcome.incoherent++
        outcome.returned += result.returned ?? 0
        log.warn(`fold on ${playbookId} was incoherent: ${result.reason ?? 'unknown'}`, {
          event: 'playbook.revision.incoherent',
          playbookId,
          reason: result.reason,
          returned: result.returned,
        })
        break
      case 'nothing-to-fold':
      case 'unknown-playbook':
        outcome.empty++
        break
    }
  }

  return outcome
}
