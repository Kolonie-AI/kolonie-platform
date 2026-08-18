import {
  BRIEFING_TICK_MULTIPLIER,
  MODERATION_NOTE_MAX_LENGTH,
  abusiveModerationNote,
  noStagesRun,
  silentLog,
  type BriefingClaim,
  type ConfidentialSpan,
  type ModerationStages,
  type PlaybookBriefingClaim,
  type ProviderBriefingClaim,
  type ReportKind,
  type Log,
  type ReportNarrative,
  type TaskId,
} from '@kolonie-ai/core'

/**
 * Re-exported from core (`#1098`) so callers that imported it from this module
 * keep working, and so `openTicket`'s rate window and this runner read the same
 * number.
 */
export { BRIEFING_TICK_MULTIPLIER }
import type {
  ApprovedEntry,
  BriefingSource,
  ModerationVerdict,
  PendingReport,
  ProviderBriefingSource,
  ProviderChange,
  ProviderKey,
  TaskText,
} from '@kolonie-ai/db'
import { markConfidential } from './confidentiality.js'
import { synthesise } from './synthesis.js'
import { describeProvider, synthesiseProvider } from './provider-synthesis.js'
import {
  synthesisePlaybook,
  type PlaybookRunSource,
  type PlaybookText,
} from './playbook-synthesis.js'
import { respondToChange, type Tripwire } from './tripwire.js'
import { findDuplicate } from './dedup.js'
import { heldQuestTick, questTick, type QuestLoopDependencies } from './quests.js'
import { atlasTick, type AtlasLoopDependencies } from './atlas.js'
import {
  atlasCategoryProposalTick,
  type AtlasCategoryProposalStore,
} from './atlas-category-proposals.js'
import { walkProseTick, type WalkProseLoopDependencies } from './walk-prose.js'
import { answerTick, type AnswerLoopDependencies } from './answers.js'
import { redLineReviewTick, type RedLineReviewLoopDependencies } from './redline-review.js'
import { questAuditTick, type QuestAuditLoopDependencies } from './quest-audit.js'
import { questEndingsTick, type QuestEndingsLoopDependencies } from './quest-endings.js'
import { questReportTick, type QuestReportLoopDependencies } from './quest-reports.js'
import {
  playbookNoteTick,
  playbookProposalTick,
  playbookRevisionTick,
  playbookTick,
  type PlaybookLoopDependencies,
  type PlaybookNoteLoopDependencies,
  type PlaybookProposalLoopDependencies,
  type PlaybookRevisionLoopDependencies,
} from './playbooks.js'
import { directionTick, type DirectionLoopDependencies } from './directions.js'
import { profileTick, type ProfileLoopDependencies } from './profiles.js'
import { judgeQuality } from './quality.js'
import { checkRedLines } from './redline.js'
import { ProviderUnreachable, type Model } from './llm.js'

/** Where the loop reads and writes. Injected, so the decision is testable without one. */
export interface ModerationStore {
  pending(limit: number): Promise<readonly PendingReport[]>
  approvedOn(query: {
    readonly kind: ReportKind
    readonly taskId: PendingReport['taskId']
  }): Promise<readonly ApprovedEntry[]>
  record(input: {
    readonly kind: ReportKind
    readonly id: string
    /**
     * The report as the moderator saw it, field by field (#113).
     *
     * The columns rather than the joined text, because the columns are what an
     * author replaces — a verdict reached against answers that have since been
     * rewritten must not be applied, and that guard can only be written against
     * what is actually stored.
     */
    readonly narrative: ReportNarrative
    readonly verdict: ModerationVerdict
    readonly model: string
    readonly stages: ModerationStages
    readonly confidentialSpans: readonly ConfidentialSpan[]
  }): Promise<{ readonly outcome: 'written' | 'stale' }>
}

/**
 * Where the loop says what it did. Injected so tests are not noisy.
 *
 * One interface for all four processes since `#230`, defined in `packages/core`
 * — three copies of a logging interface produced three log formats, and a
 * format nothing else shares is one nothing can query.
 */
export type { Log }

export interface LoopDependencies {
  readonly store: ModerationStore
  readonly model: Model
  readonly log?: Log
  /**
   * The provider-change tripwire (#115), or nothing.
   *
   * **Optional, so a runner without it moderates exactly as before.** The
   * detector is an addition to this loop rather than a stage of it — nothing
   * about a verdict passes through it — and a deployment that has not wired it
   * should degrade to the behaviour that existed, not fail to start.
   */
  readonly tripwire?: TripwireDependencies
  /**
   * The quest text stage (`#176`), or nothing.
   *
   * **Optional for the reason the tripwire is**: a deployment that has not wired
   * it moderates reports exactly as before rather than failing to start. The
   * process entry point gives quests their own runner; keeping the dependency
   * here lets callers assemble both runners from one object without duplicating
   * the model and log.
   */
  readonly quests?: QuestLoopDependencies
  /**
   * The scrub between a citizen's report and the sponsor that paid for it
   * (`#177`), or nothing. Optional for the reason the other two are.
   */
  readonly answers?: AnswerLoopDependencies
  /**
   * The second reading of the reports that scrub held on a red line (`#942`).
   *
   * **Optional like every other pass here, and the one whose absence is worst.**
   * The others degrade to *nothing happens yet*: an unjudged Atlas proposal stays
   * `pending`, an unread walk stays where it was. This one degrades to a citizen
   * whose attempt never resolves, because {@link answers} writes `held` whether
   * or not anything is wired to lift it. So it is optional for the shape and not
   * for the deployment: `main.ts` wires it wherever it wires {@link answers}, and
   * a runner with one and not the other is a misconfiguration rather than a
   * smaller installation.
   */
  readonly redLineReview?: RedLineReviewLoopDependencies
  /**
   * The second reading of quest verdicts the judge passed (`#221`, `#944`).
   *
   * **Optional like the rest, and its absence is a number rather than a queue.**
   * An unwired audit does not leave anybody waiting — the citizen was paid at the
   * verdict — but the disagreement rate it feeds stays at zero, and a rate of
   * zero is indistinguishable from a judge that is never wrong. That is the
   * brake on paid quests reading *all clear* because nothing ever tested it,
   * which is exactly the state `#944` found the Colony in when the reading
   * waited on a steward calling a tool.
   */
  readonly questAudit?: QuestAuditLoopDependencies
  /**
   * The trace behind `kolonie.quests.end` (`#944`).
   *
   * Optional in the shape and, like {@link redLineReview}, not really optional
   * in a deployment: the tier was shrunk to that one lever on the understanding
   * that every use of it lands in front of a person, and this is the half that
   * does the landing.
   */
  readonly questEndings?: QuestEndingsLoopDependencies
  /**
   * What citizens said about the quests themselves (`#240`).
   *
   * A fourth pass on the same poll, for the reason the third one is here: a
   * handful of rows a day and one model call each, against a container, a health
   * check and a deploy step.
   */
  readonly questReports?: QuestReportLoopDependencies
  /**
   * The judged playbook review pass (`#1219`), or nothing.
   *
   * **Optional in the shape and not in a deployment**, like {@link redLineReview}
   * and for the sharper version of its reason. The other optional passes degrade
   * to *nothing happens yet*. This one degrades to a citizen whose playbook sits
   * in `review` forever, because `submitPlaybookForReview` moves a draft there
   * whether or not anything is wired to judge it — and until this pass existed
   * that submit published in the same transaction, so an unwired runner is a
   * regression rather than a smaller installation.
   */
  readonly playbooks?: PlaybookLoopDependencies
  /**
   * Judging the notes citizens file about the playbooks they ran (`#1246`).
   *
   * Separate from {@link playbooks} because it is a separate queue with a
   * separate store, and optional for the same reason: an unwired runner leaves
   * a note `pending` and publishes nothing, which is the safe degradation. The
   * report it hangs off is published either way — `#1246` is explicit that a
   * note nobody judged costs its author nothing.
   */
  readonly playbookNotes?: PlaybookNoteLoopDependencies
  /**
   * Judging proposed changes to a published playbook's steps (`#1254`).
   *
   * Separate from {@link playbookNotes} because it is a separate queue with a
   * separate store. Optional for the same reason: an unwired runner leaves a
   * proposal `pending` and accepts nothing, which is the safe degradation —
   * accepted proposals do not apply themselves until `#1255` either way.
   */
  readonly playbookProposals?: PlaybookProposalLoopDependencies
  /**
   * Folding accepted step proposals into playbook revisions (`#1255`).
   *
   * Runs after {@link playbookProposals} so a proposal accepted this cycle can
   * fold in the same pass. Optional: an unwired runner leaves accepted
   * proposals unfolded, which is the safe degradation — the live steps stay
   * as they were.
   */
  readonly playbookRevisions?: PlaybookRevisionLoopDependencies
  /**
   * Reading what citizens said they want to become (`#140`).
   *
   * A fifth pass on the same poll, for the reason the fourth one is here — and
   * with one property none of the others have: **nothing anywhere waits on its
   * result.** A citizen with no reading has no declared preference, and a
   * listing with no preference is the listing the Colony served before this
   * existed.
   */
  readonly directions?: DirectionLoopDependencies
  /**
   * The profile fields waiting to be read before they are published (`#827`).
   *
   * Optional like every other extra pass, so a deployment that has not wired it
   * runs the moderator exactly as before — and, because publication is the
   * absence of a write rather than a default, an unwired pass publishes nothing
   * rather than everything.
   */
  readonly profiles?: ProfileLoopDependencies
  /**
   * Whether a proposed provider belongs on the map (`#812`).
   *
   * A sixth pass on the same poll, and the one whose absence was hardest to see:
   * the Atlas queue was never backed up, it was unattended, which looks
   * identical from outside. Absent leaves every proposal `pending` for a
   * steward, which is exactly where they were before this existed.
   */
  readonly atlas?: AtlasLoopDependencies
  /**
   * What a walker wrote about the provider it walked (`#810`).
   *
   * An eighth pass on the same poll, and the one with the largest backlog behind
   * it: every walk ever finished collected up to six free-text answers and not
   * one of them had a reader, because the stage that would have given them one
   * was never built. Absent leaves each walk `pending`, which serves nothing —
   * the same place those words sat before this existed, and no worse.
   */
  readonly walkProse?: WalkProseLoopDependencies
  /**
   * The retention sweep over the contribution verdict ledger (`#1259`).
   *
   * **Optional like every other pass, and the one whose absence costs the
   * least in the short run and the most in the long one.** An unwired sweep
   * publishes nothing wrong and stops nothing working: the ledger simply keeps
   * every row it was ever given. What it costs is the promise the table was
   * written under — that an early bad week does not follow a citizen forever —
   * which is a retention commitment rather than a queue, so it degrades slowly
   * and invisibly rather than loudly.
   *
   * A function rather than a store, because there is exactly one call and no
   * decision in front of it. `now` is passed in for the reason
   * `sweepContributionVerdicts` takes it: a retention boundary that cannot be
   * tested without waiting a year is not tested.
   */
  readonly sweepContributionVerdicts?: (now: Date) => Promise<number>
}

/** The tripwire as this loop needs it: detect, then respond. */
export interface TripwireDependencies extends Tripwire {
  detect(taskId: TaskId): Promise<ProviderChange | null>
}

/**
 * What one entry's moderation came to.
 *
 * `failed` is its own outcome rather than a thrown error, because a model that
 * refuses one entry must not stop the ones behind it — a single unparseable
 * reply should cost that entry a poll, not the queue an hour.
 */
export type Judgement =
  | { readonly kind: 'approved' }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'merged'; readonly into: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * Judge one entry: red lines, then quality, then confidentiality, then duplication.
 *
 * **The order is deliberate and it is not the order the issue listed them in.**
 * Each stage costs a model call, and each is an exit — so the cheapest and most
 * severe goes first. An entry that crosses a red line is refused without ever
 * paying for a quality call or an embedding, and it is refused regardless of how
 * well written it is, which is the property that matters: an articulate
 * instruction to hand over a credential must not survive because it cleared a
 * quality bar.
 *
 * **Confidentiality is third and it is the one stage that is not an exit.** It
 * cannot refuse anything (#84), so it buys no early return and its position is
 * decided entirely by what would be wasted: before quality it would mark entries
 * that are about to be thrown out, and after dedup it would be too late, because
 * dedup and everything downstream have to already know which spans are not
 * repeatable.
 *
 * Dedup is last because it is the only stage whose answer depends on what is
 * already published. Running it first would spend an embedding call on entries
 * that were never going to be published at all.
 *
 * **Nothing here writes `approved` twice.** `recordModeration` guards on the row
 * still being `pending`, so a second runner that picked up the same entry writes
 * nothing rather than overwriting a verdict — the same rule the verifier runner
 * follows about a submission whose verdict arrived late.
 *
 * **Every stage's answer is accumulated as it goes, and the ones that never ran
 * say so.** `stages` starts as four `not-run` entries and each stage fills in its
 * own, so an entry refused on a red line records that quality, confidentiality and
 * dedup were never reached — rather than recording nothing about them, which would
 * make *the quality check passed it* and *the quality check never looked* the same
 * row.
 */
export async function judge(entry: PendingReport, deps: LoopDependencies): Promise<Judgement> {
  const { store, model, log = silentLog } = deps
  let stages = noStagesRun()
  // Accumulated alongside `stages` and for the same reason: an entry rejected
  // before this stage ran carries an empty list, and that is the honest answer —
  // nothing was found because nothing looked. `stages.confidentiality` is what
  // says which of the two happened.
  let confidentialSpans: readonly ConfidentialSpan[] = []

  try {
    const redLine = await checkRedLines(entry, model)
    stages = {
      ...stages,
      redLine:
        redLine.kind === 'clear'
          ? { outcome: 'clear' }
          : { outcome: 'crossed', reason: note(redLine.reason) },
    }

    if (redLine.kind === 'crossed') {
      // Red-line refusals are abusive with no second model call (`#1260`).
      const told = note(abusiveModerationNote(redLine.reason))
      return await write(
        entry,
        { decision: 'reject', note: told, refusal: 'abusive' },
        deps,
        stages,
        confidentialSpans,
        { kind: 'rejected', reason: told },
      )
    }

    const quality = await judgeQuality(entry, model)
    stages = {
      ...stages,
      quality:
        quality.kind === 'useful'
          ? { outcome: 'approve' }
          : {
              // `abusive` is its own outcome so an audit row can tell the two
              // refusal arms apart without reading the ledger (`#1260`).
              outcome: quality.kind === 'abusive' ? 'abusive' : 'reject',
              reason: note(quality.reason),
            },
    }

    if (quality.kind === 'useless' || quality.kind === 'abusive') {
      const told =
        quality.kind === 'abusive'
          ? note(abusiveModerationNote(quality.reason))
          : note(quality.reason)
      return await write(
        entry,
        {
          decision: 'reject',
          note: told,
          refusal: quality.kind === 'abusive' ? 'abusive' : 'useless',
        },
        deps,
        stages,
        confidentialSpans,
        { kind: 'rejected', reason: told },
      )
    }

    // No branch on the result, and there is no version of this stage that has
    // one. Its outcome is recorded and carried; it never changes what happens
    // next. See `confidentiality.ts` for why that is a constraint and not a
    // simplification.
    const confidential = await markConfidential(entry, model)
    confidentialSpans = confidential.spans
    stages = {
      ...stages,
      confidentiality:
        confidential.spans.length === 0
          ? { outcome: 'clean' }
          : {
              outcome: 'marked',
              // The kinds and the count, never the values. This lands in
              // `moderations.stages`, which is a longer-lived and wider-read
              // table than the entry — copying an author's mailbox address into
              // an audit row would spread what the stage exists to contain.
              reason: note(
                `${confidential.spans.length} span(s): ` +
                  [...new Set(confidential.spans.map((span) => span.kind))].sort().join(', '),
              ),
            },
    }

    const approved = await store.approvedOn({ kind: entry.kind, taskId: entry.taskId })
    const duplicate = await findDuplicate(entry, approved, model)
    stages = {
      ...stages,
      dedup:
        duplicate.kind === 'distinct'
          ? // `distinct` with nothing to compare against is not the same answer as
            // `distinct` after the model was asked, and a reader reconstructing a
            // decision needs to know which. The corpus size is what separates them.
            {
              outcome: 'distinct',
              ...(approved.length === 0 && { reason: 'nothing published yet' }),
            }
          : { outcome: duplicate.of, reason: note(duplicate.reason) },
    }

    if (duplicate.kind === 'duplicate') {
      return await write(
        entry,
        { decision: 'merge', duplicateOf: duplicate.of },
        deps,
        stages,
        confidentialSpans,
        { kind: 'merged', into: duplicate.of },
      )
    }

    return await write(entry, { decision: 'approve' }, deps, stages, confidentialSpans, {
      kind: 'approved',
    })
  } catch (error) {
    // The row stays `pending`, so nothing is served and the next poll tries
    // again. A model that is down means entries accumulate unpublished, which is
    // visible and reversible — unlike a verdict written from a failed call. The
    // stages accumulated so far go with it: they explain nothing that was decided,
    // because nothing was.
    log.error(`could not moderate ${entry.kind} ${entry.id}`, error, {
      event: 'entry.moderate.failed',
      kind: entry.kind,
      entryId: entry.id,
    })
    return { kind: 'failed', error }
  }
}

/**
 * Write the verdict, and report `stale` if somebody else got there first.
 *
 * `entry.content` goes with it, and not as a convenience: it is what the moderator
 * actually judged, and `recordModeration` refuses to apply a verdict to text that
 * has changed since. An author may revise a pending entry (`#74`), which leaves the
 * status `pending` — so the text is the only thing that can tell a verdict reached
 * about *this* report from one reached about the report it replaced.
 */
async function write(
  entry: PendingReport,
  verdict: ModerationVerdict,
  deps: LoopDependencies,
  stages: ModerationStages,
  confidentialSpans: readonly ConfidentialSpan[],
  judgement: Judgement,
): Promise<Judgement> {
  const written = await deps.store.record({
    kind: entry.kind,
    id: entry.id,
    narrative: entry.narrative,
    verdict,
    model: deps.model.name,
    stages,
    confidentialSpans,
  })
  return written.outcome === 'stale' ? { kind: 'stale' } : judgement
}

/**
 * The model's reason, cut to what the column holds.
 *
 * Truncated rather than refused. The note is read by the citizen whose entry was
 * turned down, and a verdict that failed to write because the explanation ran
 * long would leave the entry `pending` forever — an unexplained rejection is
 * bad, an entry stuck in limbo is worse.
 */
function note(reason: string): string {
  const trimmed = reason.trim()
  return trimmed.length <= MODERATION_NOTE_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MODERATION_NOTE_MAX_LENGTH - 1)}…`
}

/** What one pass over the queue came to. */
export interface TickOutcome {
  readonly judged: number
  readonly approved: number
  readonly rejected: number
  readonly merged: number
  readonly failed: number
}

/**
 * Take one batch of unjudged entries through the pipeline.
 *
 * Sequential rather than concurrent, and that is a decision about correctness
 * rather than about load. Two entries on the same task judged in parallel would
 * each be compared against a corpus that does not yet contain the other, so a
 * pair of identical reports arriving together would both be approved — and the
 * duplicate they were supposed to merge into would be each other.
 */
export async function tick(deps: LoopDependencies, batchSize: number): Promise<TickOutcome> {
  const { store, log = silentLog } = deps
  const entries = await store.pending(batchSize)

  const outcome = { judged: 0, approved: 0, rejected: 0, merged: 0, failed: 0 }

  /**
   * Tasks touched this batch, so the tripwire is asked once per task rather
   * than once per entry (#115). A batch of five reports on one task is one
   * question about that task, and asking five times would spend four queries to
   * get the same answer — and, on the fifth, an answer already made false by the
   * cooldown the first one started.
   */
  const touched = new Set<TaskId>()

  for (const entry of entries) {
    const judgement = await judge(entry, deps)
    outcome.judged++
    if (judgement.kind === 'approved' || judgement.kind === 'merged') touched.add(entry.taskId)

    switch (judgement.kind) {
      case 'approved':
        outcome.approved++
        log.info(`${entry.kind} ${entry.id} approved`, {
          event: 'entry.judged',
          kind: entry.kind,
          entryId: entry.id,
          verdict: 'approved',
        })
        break
      case 'rejected':
        outcome.rejected++
        log.info(`${entry.kind} ${entry.id} rejected: ${judgement.reason}`, {
          event: 'entry.judged',
          kind: entry.kind,
          entryId: entry.id,
          verdict: 'rejected',
        })
        break
      case 'merged':
        outcome.merged++
        log.info(`${entry.kind} ${entry.id} merged into ${judgement.into}`, {
          event: 'entry.judged',
          kind: entry.kind,
          entryId: entry.id,
          verdict: 'merged',
          into: judgement.into,
        })
        break
      case 'stale':
        log.warn(`${entry.kind} ${entry.id} was already judged when its verdict arrived`, {
          event: 'entry.stale',
          kind: entry.kind,
          entryId: entry.id,
        })
        break
      case 'failed':
        outcome.failed++
        break
    }
  }

  await checkTripwire(touched, deps, log)
  await scrubAnswers(deps, batchSize, log)
  await reviewRedLines(deps, batchSize, log)
  await auditQuestVerdicts(deps, batchSize, log)
  await fileQuestEndings(deps, batchSize, log)
  await scrubQuestReports(deps, batchSize, log)
  await readDirections(deps, batchSize, log)
  await readProfiles(deps, batchSize, log)
  await judgeAtlasProposals(deps, batchSize, log)
  await scrubWalkProse(deps, batchSize, log)

  return outcome
}

/**
 * Scrub what walkers wrote, on the same poll (`#810`).
 *
 * Its failure is swallowed like every other pass's. What a failed poll costs
 * here is a page staying unread for one more tick: the row stays in whichever
 * queue state selected it, nothing partial is served, and the next poll picks it
 * up — the shape every scrub in this file settled on, for the same reason they
 * all settled on it.
 */
async function scrubWalkProse(deps: LoopDependencies, batchSize: number, log: Log): Promise<void> {
  const { walkProse } = deps
  if (walkProse === undefined) return

  try {
    const outcome = await walkProseTick({ log, ...walkProse }, batchSize)
    /**
     * The repeats count too: a tick that judged nothing may still have marked
     * one (`#1109`) — and so do the re-queued refusals (`#1108`), which is the
     * one line saying a scrubber version bump has started working through the
     * refusals the last one reached.
     */
    if (outcome.judged > 0 || outcome.repeats > 0 || outcome.requeued > 0) {
      log.info(
        `walk prose: ${outcome.judged} judged, ${outcome.scrubbed} scrubbed, ` +
          `${outcome.refused} refused, ${outcome.failed} deferred, ` +
          `${outcome.repeats} marked as repeats, ${outcome.requeued} re-queued`,
        {
          event: 'walk-prose.pass.done',
          judged: outcome.judged,
          scrubbed: outcome.scrubbed,
          refused: outcome.refused,
          failed: outcome.failed,
          repeats: outcome.repeats,
          requeued: outcome.requeued,
        },
      )
    }
  } catch (error) {
    log.error('the walk prose pass failed', error, { event: 'walk-prose.pass.failed' })
  }
}

/**
 * Judge the proposed providers, on the same poll (`#812`).
 *
 * Its failure is swallowed like every other pass's, and what a failed poll costs
 * here is that a queue nobody was working stays where it was for fifteen more
 * seconds. The pass itself already leaves an unjudged proposal `pending` rather
 * than deciding it badly, so there is no half state for this to clean up.
 */
async function judgeAtlasProposals(
  deps: LoopDependencies,
  batchSize: number,
  log: Log,
): Promise<void> {
  const { atlas } = deps
  if (atlas === undefined) return

  try {
    const outcome = await atlasTick({ log, ...atlas }, batchSize)
    if (outcome.judged > 0) {
      log.info(
        `atlas proposals: ${outcome.judged} judged, ${outcome.accepted} listed, ` +
          `${outcome.refused} refused, ${outcome.merged} merged, ${outcome.failed} deferred`,
        {
          event: 'atlas.pass.done',
          judged: outcome.judged,
          accepted: outcome.accepted,
          refused: outcome.refused,
          merged: outcome.merged,
          failed: outcome.failed,
        },
      )
    }
  } catch (error) {
    log.error('the atlas proposal pass failed', error, { event: 'atlas.pass.failed' })
  }
}

/**
 * Read the profile fields waiting on a check, on the same poll (`#827`).
 *
 * Its failure is swallowed like every other extra pass's, and the cost is worth
 * naming because it is not the same as the others': what a failed pass costs is
 * that new edits stop appearing on profile pages. Nothing already published
 * changes, nothing unchecked is published, and the citizen's own console keeps
 * saying the field is waiting — which is the honest report of what is happening.
 *
 * `profileTick` already logs its own counts, so this wrapper does not log a
 * second line on the way past.
 */
async function readProfiles(deps: LoopDependencies, batchSize: number, log: Log): Promise<void> {
  const { profiles } = deps
  if (profiles === undefined) return

  try {
    await profileTick({ log, ...profiles }, batchSize)
  } catch (error) {
    log.error('the profile pass failed', error, { event: 'profile.pass.failed' })
  }
}

/**
 * Read the declarations waiting on a classifier, on the same poll (`#140`).
 *
 * Its failure is swallowed like every other extra pass's, and here the argument
 * is the strongest it gets: what a failed pass costs is an ordering, and the
 * fallback ordering is the Colony's own. Nothing a citizen can see breaks.
 */
async function readDirections(deps: LoopDependencies, batchSize: number, log: Log): Promise<void> {
  const { directions } = deps
  if (directions === undefined) return

  try {
    const outcome = await directionTick({ log, ...directions }, batchSize)
    if (outcome.classified > 0 || outcome.deferred > 0) {
      log.info(
        `directions: ${outcome.classified} of ${outcome.read} read, ${outcome.deferred} deferred`,
        {
          event: 'direction.pass.done',
          read: outcome.read,
          classified: outcome.classified,
          deferred: outcome.deferred,
        },
      )
    }
  } catch (error) {
    log.error('the direction pass failed', error, { event: 'direction.pass.failed' })
  }
}

/**
 * Scrub the quest reports waiting on it, on the same poll (`#177`).
 *
 * Its failure is swallowed like the other two passes': the three share a
 * process and a schedule and nothing else, and a queue that throws must not stop
 * the reports being published.
 */
async function scrubAnswers(deps: LoopDependencies, batchSize: number, log: Log): Promise<void> {
  const { answers } = deps
  if (answers === undefined) return

  try {
    const outcome = await answerTick({ log, ...answers }, batchSize)
    if (outcome.judged > 0) {
      log.info(
        `quest reports: ${outcome.judged} read, ${outcome.scrubbed} scrubbed, ` +
          `${outcome.held} held for a second reading, ${outcome.failed} deferred`,
        {
          event: 'answers.pass.done',
          judged: outcome.judged,
          scrubbed: outcome.scrubbed,
          held: outcome.held,
          failed: outcome.failed,
        },
      )
    }
  } catch (error) {
    log.error('the quest report scrub failed', error, { event: 'answers.pass.failed' })
  }
}

/**
 * Read the reports held on a red line a second time, on the same poll (`#942`).
 *
 * **Immediately after {@link scrubAnswers}, and that ordering is deliberate.**
 * The scrub is what puts reports into `held`; running the reading behind it on
 * the same poll means a report flagged at 12:00 has its verdict at 12:00 rather
 * than a poll later. Nothing depends on the order — the reading queries the held
 * rows itself — so a poll that got them the other way round is slower and not
 * wrong.
 *
 * Its failure is swallowed like every other pass', with one asymmetry worth
 * stating: a throw here leaves reports held, which is the state `#942` exists to
 * make unreachable. It is survivable only because the next poll finds them again
 * — the queue is oldest-first and nothing removes a row from it but a verdict.
 */
async function reviewRedLines(deps: LoopDependencies, batchSize: number, log: Log): Promise<void> {
  const { redLineReview } = deps
  if (redLineReview === undefined) return

  try {
    const outcome = await redLineReviewTick({ log, ...redLineReview }, batchSize)
    if (outcome.read > 0) {
      log.info(
        `red-line holds: ${outcome.read} read a second time, ${outcome.released} released, ` +
          `${outcome.upheld} upheld, ${outcome.stale} already ruled on`,
        {
          event: 'redline.review.pass.done',
          read: outcome.read,
          released: outcome.released,
          upheld: outcome.upheld,
          stale: outcome.stale,
        },
      )
    }
  } catch (error) {
    log.error('the red-line second reading failed', error, {
      event: 'redline.review.pass.failed',
    })
  }
}

/**
 * Read a sample of passed quest verdicts a second time, on the same poll
 * (`#221`, `#944`).
 *
 * **The reason it is here at all is that a queue is not a programme.** `#221`
 * built the sample, the rate and the brake, and then made every one of them wait
 * on a steward calling `kolonie.quests.audit` — so the Colony's measurement of
 * its own judge was a number nobody was scheduled to produce. Beside the other
 * passes it runs whether or not anyone is watching, which is the whole of what
 * `#944` asked for.
 *
 * Its failure is swallowed like every other pass', and here that costs the least
 * of any of them: the candidates are drawn again next poll and nothing partial
 * was written, because a reading that did not finish records no row.
 */
async function auditQuestVerdicts(
  deps: LoopDependencies,
  batchSize: number,
  log: Log,
): Promise<void> {
  const { questAudit } = deps
  if (questAudit === undefined) return

  try {
    const outcome = await questAuditTick({ log, ...questAudit }, batchSize)
    if (outcome.read > 0) {
      log.info(
        `quest audit: ${outcome.read} verdicts read a second time, ${outcome.agreed} upheld, ` +
          `${outcome.disagreed} disagreed with, ${outcome.unread} left unrecorded, ` +
          `${outcome.stale} already audited`,
        {
          event: 'quest.audit.pass.done',
          read: outcome.read,
          agreed: outcome.agreed,
          disagreed: outcome.disagreed,
          unread: outcome.unread,
          stale: outcome.stale,
        },
      )
    }
  } catch (error) {
    log.error('the quest audit failed', error, { event: 'quest.audit.pass.failed' })
  }
}

/**
 * File the trace behind every use of the steward lever, on the same poll
 * (`#944`).
 *
 * The only pass here that calls no model: it reads rows and writes issues, and
 * what it costs on a poll where nothing was stopped by hand — which is nearly
 * every poll — is one bounded query.
 */
async function fileQuestEndings(
  deps: LoopDependencies,
  batchSize: number,
  log: Log,
): Promise<void> {
  const { questEndings } = deps
  if (questEndings === undefined) return

  try {
    const outcome = await questEndingsTick({ log, ...questEndings }, batchSize)
    if (outcome.filed > 0) {
      log.info(
        `steward lever: ${outcome.filed} endings filed, ${outcome.skipped} already filed or ` +
          'unfileable',
        {
          event: 'quest.ending.pass.done',
          read: outcome.read,
          filed: outcome.filed,
          skipped: outcome.skipped,
        },
      )
    }
  } catch (error) {
    log.error('filing the steward lever’s endings failed', error, {
      event: 'quest.ending.pass.failed',
    })
  }
}

/**
 * Scrub what citizens said about the quests themselves, on the same poll
 * (`#240`).
 *
 * Its failure is swallowed like the other passes': they share a process and a
 * schedule and nothing else, and a queue that throws must not stop the rest.
 */
async function scrubQuestReports(
  deps: LoopDependencies,
  batchSize: number,
  log: Log,
): Promise<void> {
  const { questReports } = deps
  if (questReports === undefined) return

  try {
    const outcome = await questReportTick({ log, ...questReports }, batchSize)
    if (outcome.judged > 0) {
      log.info(
        `quest reports about quests: ${outcome.judged} read, ${outcome.scrubbed} scrubbed, ` +
          `${outcome.refused} refused, ${outcome.failed} deferred`,
        {
          event: 'quest-report.pass.done',
          judged: outcome.judged,
          scrubbed: outcome.scrubbed,
          refused: outcome.refused,
          failed: outcome.failed,
        },
      )
    }
  } catch (error) {
    log.error('the quest report scrub failed', error, { event: 'quest-report.pass.failed' })
  }
}

/**
 * Run one quest pass (`#176`).
 *
 * **Its failure is swallowed, exactly as the tripwire's is.** A quest queue that
 * throws must not stop the quest runner: what the quests lose is one poll, which
 * is a delay a sponsor can wait out rather than a dead queue.
 */
async function moderateQuests(deps: LoopDependencies, batchSize: number, log: Log): Promise<void> {
  const { quests } = deps
  if (quests === undefined) return

  try {
    const outcome = await questTick({ log, ...quests }, batchSize)
    if (outcome.judged > 0 || outcome.released > 0 || outcome.held > 0) {
      log.info(
        `quests: ${outcome.judged} judged, ${outcome.approved} cleared, ` +
          `${outcome.published} published, ${outcome.rejected} refused, ` +
          `${outcome.failed} deferred, ${outcome.released} released late, ` +
          `${outcome.held} held`,
        {
          event: 'quests.pass.done',
          judged: outcome.judged,
          approved: outcome.approved,
          published: outcome.published,
          rejected: outcome.rejected,
          failed: outcome.failed,
          released: outcome.released,
          held: outcome.held,
        },
      )
    }
  } catch (error) {
    log.error('the quest moderation pass failed', error, { event: 'quests.pass.failed' })
  }
}

/**
 * Run one playbook pass (`#1219`).
 *
 * **On the quest runner's poll rather than the report runner's**, because the
 * two waits are the same wait: a citizen that has just offered a playbook to the
 * catalogue is sitting in front of `kolonie.playbooks.read` watching for the
 * status to move, exactly as a sponsor watches a quest. The report queues nobody
 * is waiting on run on the slower timer.
 *
 * Its failure is swallowed for {@link moderateQuests}' reason: a playbook queue
 * that throws must not take the quests down with it, and what the playbooks lose
 * is one poll.
 */
async function moderatePlaybooks(
  deps: LoopDependencies,
  batchSize: number,
  log: Log,
): Promise<void> {
  const { playbooks } = deps
  if (playbooks === undefined) return

  try {
    const outcome = await playbookTick({ log, ...playbooks }, batchSize)
    if (outcome.judged > 0 || outcome.released > 0) {
      log.info(
        `playbooks: ${outcome.judged} judged, ${outcome.approved} cleared, ` +
          `${outcome.published} published, ${outcome.rejected} returned, ` +
          `${outcome.failed} deferred, ${outcome.released} released late`,
        {
          event: 'playbooks.pass.done',
          judged: outcome.judged,
          approved: outcome.approved,
          published: outcome.published,
          rejected: outcome.rejected,
          failed: outcome.failed,
          released: outcome.released,
        },
      )
    }
  } catch (error) {
    log.error('the playbook moderation pass failed', error, { event: 'playbooks.pass.failed' })
  }
}

/**
 * One pass over the run notes waiting on a verdict (`#1246`).
 *
 * Its failure is swallowed for {@link moderatePlaybooks}' reason, with one more
 * behind it: a note is the optional half of a report that has already been
 * accepted and already paid, so a queue that throws costs the Colony a sentence
 * and costs its author nothing at all.
 */
async function moderatePlaybookNotes(
  deps: LoopDependencies,
  batchSize: number,
  log: Log,
): Promise<void> {
  const { playbookNotes } = deps
  if (playbookNotes === undefined) return

  try {
    const outcome = await playbookNoteTick({ log, ...playbookNotes }, batchSize)
    if (outcome.judged > 0) {
      log.info(
        `playbook notes: ${outcome.judged} judged, ${outcome.approved} published, ` +
          `${outcome.rejected} returned, ${outcome.failed} deferred`,
        {
          event: 'playbook-notes.pass.done',
          judged: outcome.judged,
          approved: outcome.approved,
          rejected: outcome.rejected,
          failed: outcome.failed,
        },
      )
    }
  } catch (error) {
    log.error('the playbook note moderation pass failed', error, {
      event: 'playbook-notes.pass.failed',
    })
  }
}

/**
 * One pass over the step proposals waiting on a verdict (`#1254`).
 *
 * Its failure is swallowed for {@link moderatePlaybookNotes}' reason: a
 * proposal nobody judged costs its author nothing, and an accepted one does
 * not apply itself until `#1255` either way.
 */
async function moderatePlaybookProposals(
  deps: LoopDependencies,
  batchSize: number,
  log: Log,
): Promise<void> {
  const { playbookProposals } = deps
  if (playbookProposals === undefined) return

  try {
    const outcome = await playbookProposalTick({ log, ...playbookProposals }, batchSize)
    if (outcome.judged > 0) {
      log.info(
        `playbook proposals: ${outcome.judged} judged, ${outcome.accepted} accepted, ` +
          `${outcome.rejected} returned, ${outcome.superseded} superseded, ${outcome.failed} deferred`,
        {
          event: 'playbook-proposals.pass.done',
          judged: outcome.judged,
          accepted: outcome.accepted,
          rejected: outcome.rejected,
          superseded: outcome.superseded,
          failed: outcome.failed,
        },
      )
    }
  } catch (error) {
    log.error('the playbook proposal moderation pass failed', error, {
      event: 'playbook-proposals.pass.failed',
    })
  }
}

/**
 * One pass folding accepted proposals into revisions (`#1255`).
 *
 * Its failure is swallowed for the same reason as the proposal pass: an
 * unfolded acceptance costs nobody anything, and the live steps stay put.
 */
async function moderatePlaybookRevisions(
  deps: LoopDependencies,
  batchSize: number,
  log: Log,
): Promise<void> {
  const { playbookRevisions } = deps
  if (playbookRevisions === undefined) return

  try {
    const outcome = await playbookRevisionTick({ log, ...playbookRevisions }, batchSize)
    if (outcome.considered > 0) {
      log.info(
        `playbook revisions: ${outcome.cut} cut, ${outcome.incoherent} incoherent, ` +
          `${outcome.folded} proposals folded, ${outcome.returned} returned`,
        {
          event: 'playbook-revisions.pass.done',
          considered: outcome.considered,
          cut: outcome.cut,
          incoherent: outcome.incoherent,
          folded: outcome.folded,
          returned: outcome.returned,
          empty: outcome.empty,
        },
      )
    }
  } catch (error) {
    log.error('the playbook revision fold pass failed', error, {
      event: 'playbook-revisions.pass.failed',
    })
  }
}

/**
 * How many quest polls pass between sweeps of the held quests (`#759`).
 *
 * **A multiplier rather than a second interval**, following
 * {@link BRIEFING_TICK_MULTIPLIER}: one timer stays one timer, and the sweep
 * keeps its ratio to the poll if the poll is retuned. 240 of the default
 * fifteen-second polls is an hour, which is the resolution a hold deserves —
 * nothing about it is urgent to retry, and the sponsor is already told.
 *
 * Counted from zero, so the first pass after a start sweeps: a runner restarted
 * because someone fixed the audit configuration heals its backlog immediately
 * rather than an hour later.
 */
export const HELD_QUEST_TICK_MULTIPLIER = 240

/**
 * Sweep the held quests, on the slow tick (`#759`).
 *
 * Swallows its failure for {@link moderateQuests}' reason, and one step further:
 * this pass is the *recovery* path, so a throw here must not take the pass that
 * publishes ordinary quests with it.
 */
async function sweepHeldQuests(deps: LoopDependencies, batchSize: number, log: Log): Promise<void> {
  const { quests } = deps
  if (quests === undefined) return

  try {
    const outcome = await heldQuestTick({ log, ...quests }, batchSize)
    if (outcome.held > 0 || outcome.released > 0 || outcome.failed > 0) {
      log.info(
        `held quests: ${outcome.held} still held, ${outcome.released} released, ` +
          `${outcome.alerted} filed, ${outcome.failed} deferred`,
        {
          event: 'quests.hold.sweep.done',
          held: outcome.held,
          released: outcome.released,
          alerted: outcome.alerted,
          failed: outcome.failed,
        },
      )
    }
  } catch (error) {
    log.error('the held quest sweep failed', error, { event: 'quests.hold.sweep.failed' })
  }
}

/**
 * How many quest polls pass between sweeps of the contribution ledger (`#1259`).
 *
 * The same 240 as {@link HELD_QUEST_TICK_MULTIPLIER}, and for a weaker version
 * of its argument: a retention boundary measured in a year does not care which
 * hour of it the row leaves, so the interval is chosen to be cheap rather than
 * timely. Hourly at the default poll, on one bounded delete.
 *
 * Counted from zero like the held sweep, so a runner that has just been given
 * the dependency clears whatever accumulated while it was unwired rather than
 * waiting an hour to start.
 */
export const CONTRIBUTION_VERDICT_SWEEP_TICK_MULTIPLIER = 240

/**
 * Drop the ledger rows past retention, on the slow tick (`#1259`).
 *
 * **Swallows its failure like every other pass, and this one can afford it more
 * than any of them.** Nothing reads the sweep's result and nobody is waiting on
 * it: a poll that throws leaves rows that are a few hours over a year old, and
 * the next sweep takes them. What must not happen is a delete failing and taking
 * the quest and playbook verdicts on the same loop down with it.
 *
 * Logs only when it deleted something, on `#108`'s rule — an hourly line saying
 * *removed 0* is the shape of a log nobody reads.
 */
async function sweepContributionVerdicts(deps: LoopDependencies, log: Log): Promise<void> {
  const { sweepContributionVerdicts: sweep } = deps
  if (sweep === undefined) return

  try {
    const removed = await sweep(new Date())
    if (removed > 0) {
      log.info(`contribution verdicts: ${removed} past retention removed`, {
        event: 'contribution-verdicts.sweep.done',
        removed,
      })
    }
  } catch (error) {
    log.error('the contribution verdict sweep failed', error, {
      event: 'contribution-verdicts.sweep.failed',
    })
  }
}

/**
 * Ask whether the world moved under any task this batch touched (#115).
 *
 * **Its own failure is swallowed**, and that is the same rule the report routing
 * follows: this is instrumentation on top of moderation, and moderation must not
 * stop because a detector threw. A missed conclusion is caught by the next batch
 * on that task; a moderation loop that dies is a corpus that never publishes.
 */
async function checkTripwire(
  touched: ReadonlySet<TaskId>,
  deps: LoopDependencies,
  log: Log,
): Promise<void> {
  const { tripwire } = deps
  if (tripwire === undefined) return

  for (const taskId of touched) {
    try {
      const change = await tripwire.detect(taskId)
      if (change !== null) await respondToChange(change, tripwire, log)
    } catch (error) {
      log.error(`tripwire failed on task ${taskId}`, error, {
        event: 'tripwire.failed',
        taskId,
      })
    }
  }
}

export interface RunnerOptions {
  readonly pollIntervalMs?: number
  readonly maxBackoffMs?: number
  readonly batchSize?: number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface Runner {
  readonly finished: Promise<void>
  stop(): Promise<void>
  health(): RunnerHealth
}

export interface RunnerHealth {
  readonly running: boolean
  readonly lastPollAt: string | null
  readonly consecutiveFailures: number
}

const DEFAULTS = {
  /**
   * A minute, where the verifier runner polls every five seconds.
   *
   * Nothing waits on a moderation verdict. An agent that files a struggle has
   * been heard the moment the row is written; whether it is published is a
   * question for other agents, later. A tight poll would spend model calls on an
   * empty queue for no gain anyone can observe.
   */
  pollIntervalMs: 60_000,
  maxBackoffMs: 600_000,
  /**
   * Small, because every entry is several model calls and this is the only
   * process in the Colony that spends money per row.
   */
  batchSize: 10,
} as const

/**
 * What a poll that threw during shutdown is, as opposed to one that failed.
 *
 * **Every full deploy left one `error` behind, and both of its claims were
 * wrong** (`#291`). `stop()` sets `running` to false and awaits the entry in
 * flight, which is right — but an `all` deploy takes Postgres down in the same
 * window, so the query in flight dies with its database and `tick()` throws. The
 * `catch` then said `poll failed … retrying in 120s` at `error`, about a process
 * that was exiting and would retry nothing.
 *
 * It cost nothing operationally and something else entirely to
 * `kolonie-docs#133`'s Watch Agent, which counts errors per service per day: a
 * standing false positive in the one signal that means *look at this* is a
 * monitor being taught to shrug.
 *
 * `running` is the whole difference and it is already in scope at both call
 * sites. Interrupted work is logged at `warn`, under its own event, promising
 * nothing — and it does not count towards `consecutiveFailures`, which exists to
 * drive backoff on a loop that has a next iteration.
 */
function reportPollThrow(
  log: Log,
  running: boolean,
  interrupted: { readonly event: string; readonly message: string },
  failed: { readonly event: string; readonly message: string; readonly retryInMs: number },
  error: unknown,
  consecutiveFailures: number,
): void {
  if (!running) {
    log.warn(interrupted.message, { event: interrupted.event })
    return
  }

  log.error(failed.message, error, {
    event: failed.event,
    consecutiveFailures,
    retryInMs: failed.retryInMs,
  })
}

/**
 * Run until stopped.
 *
 * The same shape as the verifier runner's loop, including why: backoff is on the
 * poll rather than on the entry, because a model that is refusing requests
 * refuses all of them equally and retrying each one individually turns one
 * outage into a request storm against whatever is already struggling.
 */
export function startRunner(deps: LoopDependencies, options: RunnerOptions = {}): Runner {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs
  const batchSize = options.batchSize ?? DEFAULTS.batchSize
  const sleep = options.sleep ?? realSleep
  const log = deps.log ?? silentLog

  let running = true
  let lastPollAt: string | null = null
  let consecutiveFailures = 0
  let wake: (() => void) | undefined

  const pause = async (ms: number): Promise<void> => {
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        wake = resolve
      }),
    ])
    wake = undefined
  }

  const finished = (async () => {
    while (running) {
      try {
        const outcome = await tick(deps, batchSize)
        // One line per completed cycle, even when nothing was waiting (`#230`).
        // `{event: "poll.done", handled: 0}` is not noise: it is the only thing
        // that distinguishes *the runner ran and had nothing to do* from *the
        // runner is dead*, and error monitoring structurally misses the second.
        log.info(
          outcome.judged === 0
            ? 'poll done; nothing waiting to be moderated'
            : `moderated ${outcome.judged}: ${outcome.approved} approved, ` +
                `${outcome.rejected} rejected, ${outcome.merged} merged, ` +
                `${outcome.failed} deferred`,
          {
            event: 'poll.done',
            handled: outcome.judged,
            approved: outcome.approved,
            rejected: outcome.rejected,
            merged: outcome.merged,
            failed: outcome.failed,
          },
        )
        lastPollAt = new Date().toISOString()
        consecutiveFailures = 0
        if (running) await pause(pollIntervalMs)
      } catch (error) {
        if (running) consecutiveFailures++
        const wait = Math.min(pollIntervalMs * 2 ** consecutiveFailures, maxBackoffMs)
        reportPollThrow(
          log,
          running,
          {
            event: 'poll.interrupted',
            message: 'poll interrupted by shutdown; the runner is stopping',
          },
          {
            event: 'poll.failed',
            message: `poll failed (${consecutiveFailures} in a row); retrying in ${Math.round(wait / 1000)}s`,
            retryInMs: wait,
          },
          error,
          consecutiveFailures,
        )
        if (running) await pause(wait)
      }
    }
  })()

  return {
    finished,
    async stop() {
      running = false
      wake?.()
      await finished
    },
    health: () => ({ running, lastPollAt, consecutiveFailures }),
  }
}

/**
 * Run quest moderation independently of the queues nobody is waiting on.
 *
 * A sponsor is waiting for this verdict after submitting a quest, so its faster
 * schedule must not be delayed by a report moderation pass already in flight.
 * The playbook pass rides it for the same reason (`#1219`) — an author that has
 * just offered a playbook is waiting exactly as the sponsor is — which is why
 * the name of this function is now narrower than what it runs.
 */
export function startQuestRunner(deps: LoopDependencies, options: RunnerOptions = {}): Runner {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs
  const batchSize = options.batchSize ?? DEFAULTS.batchSize
  const sleep = options.sleep ?? realSleep
  const log = deps.log ?? silentLog

  let running = true
  let lastPollAt: string | null = null
  let consecutiveFailures = 0
  let ticks = 0
  let wake: (() => void) | undefined

  const pause = async (ms: number): Promise<void> => {
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        wake = resolve
      }),
    ])
    wake = undefined
  }

  const finished = (async () => {
    while (running) {
      try {
        if (ticks % HELD_QUEST_TICK_MULTIPLIER === 0) await sweepHeldQuests(deps, batchSize, log)
        if (ticks % CONTRIBUTION_VERDICT_SWEEP_TICK_MULTIPLIER === 0)
          await sweepContributionVerdicts(deps, log)
        ticks++
        await moderateQuests(deps, batchSize, log)
        await moderatePlaybooks(deps, batchSize, log)
        await moderatePlaybookNotes(deps, batchSize, log)
        await moderatePlaybookProposals(deps, batchSize, log)
        await moderatePlaybookRevisions(deps, batchSize, log)
        lastPollAt = new Date().toISOString()
        consecutiveFailures = 0
        if (running) await pause(pollIntervalMs)
      } catch (error) {
        if (running) consecutiveFailures++
        const wait = Math.min(pollIntervalMs * 2 ** consecutiveFailures, maxBackoffMs)
        reportPollThrow(
          log,
          running,
          {
            event: 'quests.poll.interrupted',
            message: 'quest poll interrupted by shutdown; the runner is stopping',
          },
          {
            event: 'quests.poll.failed',
            message: `quest poll failed (${consecutiveFailures} in a row); retrying in ${Math.round(wait / 1000)}s`,
            retryInMs: wait,
          },
          error,
          consecutiveFailures,
        )
        if (running) await pause(wait)
      }
    }
  })()

  return {
    finished,
    async stop() {
      running = false
      wake?.()
      await finished
    },
    health: () => ({ running, lastPollAt, consecutiveFailures }),
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

/**
 * Where the synthesis reads and writes. Injected, like {@link ModerationStore}.
 *
 * A second store rather than four more methods on the first, because the two
 * loops share a process and nothing else: one judges entries, the other writes
 * documents, and a store that served both would be the seam along which somebody
 * eventually calls the wrong one.
 */
export interface BriefingStore {
  /** Tasks whose corpus has moved since their briefing was written. */
  stale(limit: number): Promise<readonly TaskId[]>
  /** What the task is called, for the synthesis prompt. */
  /**
   * What the task asks for, in its own words (#182).
   *
   * The title alone was not enough: a claim can contradict the instructions in
   * as many words and the synthesis had no way to see it.
   */
  taskText(taskId: TaskId): Promise<TaskText | undefined>
  corpus(taskId: TaskId): Promise<readonly BriefingSource[]>
  write(input: {
    readonly taskId: TaskId
    readonly claims: readonly BriefingClaim[]
    readonly model: string
  }): Promise<void>
}

/**
 * Where the provider synthesis reads and writes (`#831`).
 *
 * Its own store beside {@link BriefingStore}, on that interface's argument: the
 * two write different documents about different subjects, and one store serving
 * both would be the seam along which somebody eventually writes a task's claims
 * into a provider's row.
 */
export interface ProviderBriefingStore {
  /** Providers whose walks have moved since their briefing was written. */
  stale(limit: number): Promise<readonly ProviderKey[]>
  corpus(where: ProviderKey): Promise<readonly ProviderBriefingSource[]>
  write(
    input: ProviderKey & {
      readonly claims: readonly ProviderBriefingClaim[]
      readonly model: string
    },
  ): Promise<void>
  /**
   * Put the one sentence saying what the provider is onto its entry (`#1120`).
   *
   * **A second write and not a field of the first**, because the briefing write
   * deletes its row when there are no claims (`#611`) and the description must
   * not be deleted with it. Answers whether an entry was there to write on: a
   * provider with walks but no Atlas entry gets nothing, which is not a failure.
   */
  describe(input: ProviderKey & { readonly description: string }): Promise<boolean>
}

/**
 * Where the playbook briefing is read and written (`#1251`).
 *
 * **No dirty queue yet.** A note approval or a revision cut calls
 * {@link synthesisePlaybookNow} directly. Batching behind a flag is a later
 * cost once the corpus is busy enough that one approval per synthesis is the
 * expensive shape; until then the write at the end of each synthesis is the
 * whole of what this issue ships.
 */
export interface PlaybookBriefingStore {
  subject(playbookId: string): Promise<PlaybookText | undefined>
  corpus(playbookId: string): Promise<readonly PlaybookRunSource[]>
  write(
    playbookId: string,
    claims: readonly PlaybookBriefingClaim[],
    revision: number,
  ): Promise<void>
}

export interface BriefingDependencies {
  readonly store: BriefingStore
  /**
   * The provider half, when it is configured (`#831`).
   *
   * **Optional, and the same tick rather than a third runner.** A second poll
   * loop would need its own backoff, its own outage rule and its own health
   * entry, all of which exist here and all of which are about the model rather
   * than about tasks — the provider that refuses a task synthesis is refusing
   * the provider synthesis in the same second. Running both phases inside
   * {@link briefingTick} means one outage is still one alarm.
   *
   * Optional so that a deployment can run the task briefings without the
   * provider ones, and so that every existing test constructing these
   * dependencies keeps compiling and keeps testing what it tested.
   */
  readonly providers?: ProviderBriefingStore
  /**
   * Where the category proposals are read and raised, when configured (`#1106`).
   *
   * Optional for {@link providers}' reason and one more of its own: this pass
   * writes nothing a reader ever sees. It fills a queue a maintainer decides,
   * so a deployment that has nobody to decide can leave it out and lose nothing
   * but the queue.
   */
  readonly categories?: AtlasCategoryProposalStore
  readonly model: Model
  readonly log?: Log
}

/** What one pass over the stale tasks came to. */
export interface BriefingTickOutcome {
  readonly written: number
  readonly failed: number
  /**
   * How many of {@link failed} were the provider being unreachable rather than
   * the synthesis going wrong (`#449`). Counted separately because the two need
   * opposite reactions, and because a pass that is *entirely* this is an outage
   * rather than a batch of defects — see {@link briefingTick}.
   */
  readonly unreachable: number
}

/** What one task's pass came to. Three outcomes, because two of them are failures for different reasons. */
export type SynthesisOutcome = 'written' | 'failed' | 'unreachable'

/**
 * Rewrite every briefing whose corpus has moved.
 *
 * **The dirty flag is what makes this affordable**, and it is the whole reason
 * this is a separate loop rather than a step at the end of `judge`. A task that
 * collects two hundred reports must not cost two hundred syntheses: approval sets
 * a flag, and one pass here consumes however many changes accumulated since the
 * last one. Two hundred approvals inside one tick interval cost **one** call.
 *
 * Sequential for the reason `tick` is, though a weaker one: nothing here is
 * order-dependent, but this process is the one that spends money per row and a
 * burst of parallel syntheses is the shape of an accident.
 *
 * A task whose synthesis throws keeps its flag and is retried next pass. That is
 * the same failure direction as moderation: nothing is published rather than
 * something wrong being published, and the stale briefing that stays in place is
 * served with its age visible.
 */
export async function briefingTick(
  deps: BriefingDependencies,
  batchSize: number,
): Promise<BriefingTickOutcome> {
  const { store, providers, categories, model, log = silentLog } = deps
  const outcome = { written: 0, failed: 0, unreachable: 0 }

  for (const taskId of await store.stale(batchSize)) {
    const result = await synthesiseNow(store, model, taskId, log)
    if (result === 'written') outcome.written++
    else {
      outcome.failed++
      if (result === 'unreachable') outcome.unreachable++
    }
  }

  /**
   * The provider phase, counted into the same three numbers (`#831`).
   *
   * **One batch size for both**, so a pass costs at most twice it rather than
   * some new configured amount nobody would tune separately. And one set of
   * counters, so the outage rule below covers both phases: with the model gone,
   * every task and every provider fails the same way, and that is one alarm.
   *
   * Second rather than first because the task briefings are what a citizen
   * reads before every attempt, and if a batch is going to exhaust anything it
   * should exhaust it on the provider half.
   */
  for (const where of (await providers?.stale(batchSize)) ?? []) {
    const result = await synthesiseProviderNow(
      providers as ProviderBriefingStore,
      model,
      where,
      log,
    )
    if (result === 'written') outcome.written++
    else {
      outcome.failed++
      if (result === 'unreachable') outcome.unreachable++
    }
  }

  /**
   * **A pass that reached nothing is an outage, and it is raised once** (`#449`).
   *
   * Per task, an unreachable provider is a warning: the flag stays set and the
   * next poll writes the briefing. But a pass in which *every* attempt failed
   * that way, and none succeeded, is not a run of unlucky tasks — the provider
   * is not there, and nothing this loop does next will change that until it is.
   *
   * Throwing hands it to the runner's existing arrangement rather than building
   * a second one: `startBriefingRunner` catches it, logs one
   * `briefing.poll.failed` at error, counts it toward `consecutiveFailures` and
   * doubles the wait. That is precisely what its own comment already argues for
   * — *"a model that is refusing requests refuses all of them, and retrying each
   * task individually turns one outage into a request storm"* — and it means
   * one line per poll during an outage instead of one per task, with a backoff
   * behind it.
   *
   * **The empty batch is excluded by construction.** With nothing stale,
   * `unreachable` is 0 and this does not fire; a quiet loop keeps saying so
   * through `briefing.poll.done`.
   */
  if (outcome.written === 0 && outcome.unreachable > 0 && outcome.unreachable === outcome.failed) {
    throw new ProviderUnreachable(
      '/chat/completions',
      new Error(`${outcome.unreachable} briefing(s) in this pass reached no provider`),
    )
  }

  /**
   * Where a provider belongs in the Atlas, proposed for a maintainer (`#1106`).
   *
   * **After the outage check, and that placement is the whole of its error
   * handling.** A model that is not there has already thrown by this line, so the
   * pass never spends a call discovering the same outage a third time; and a
   * pass that got here has a model that answers.
   *
   * **Counted into nothing above it**, on `describeProviderNow`'s argument: a
   * proposal is advice waiting on a maintainer, and losing a briefing that was
   * written, paid for and about to be served because a suggestion failed would be
   * the wrong trade in every direction. Its own numbers go to the log, where the
   * thing worth watching — proposals raised against pairs considered — is
   * readable without being confused with briefings written.
   */
  if (categories !== undefined) {
    const proposals = await atlasCategoryProposalTick({ store: categories, model, log }, batchSize)

    if (proposals.considered > 0) {
      log.info(
        `category proposals: ${proposals.raised} raised over ${proposals.considered} pairs`,
        { event: 'atlas.category.pass', ...proposals },
      )
    }
  }

  return outcome
}

/**
 * Run the synthesis loop until stopped.
 *
 * The same shape as {@link startRunner}, including the backoff argument: a model
 * that is refusing requests refuses all of them, and retrying each task
 * individually turns one outage into a request storm.
 */
export function startBriefingRunner(
  deps: BriefingDependencies,
  options: RunnerOptions = {},
): Runner {
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULTS.pollIntervalMs * BRIEFING_TICK_MULTIPLIER
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs
  const batchSize = options.batchSize ?? DEFAULTS.batchSize
  const sleep = options.sleep ?? realSleep
  const log = deps.log ?? silentLog

  let running = true
  let lastPollAt: string | null = null
  let consecutiveFailures = 0
  let wake: (() => void) | undefined

  const pause = async (ms: number): Promise<void> => {
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        wake = resolve
      }),
    ])
    wake = undefined
  }

  const finished = (async () => {
    while (running) {
      try {
        const outcome = await briefingTick(deps, batchSize)
        // Same rule as the moderation cycle above: a completed pass says so even
        // when it wrote nothing, because the synthesis loop runs on its own
        // interval and silence is otherwise indistinguishable from death.
        log.info(
          outcome.written === 0 && outcome.failed === 0
            ? 'briefing poll done; nothing to synthesise'
            : `briefings: ${outcome.written} written, ${outcome.failed} deferred`,
          {
            event: 'briefing.poll.done',
            written: outcome.written,
            failed: outcome.failed,
          },
        )
        lastPollAt = new Date().toISOString()
        consecutiveFailures = 0
        if (running) await pause(pollIntervalMs)
      } catch (error) {
        if (running) consecutiveFailures++
        const wait = Math.min(pollIntervalMs * 2 ** consecutiveFailures, maxBackoffMs)
        reportPollThrow(
          log,
          running,
          {
            event: 'briefing.poll.interrupted',
            message: 'briefing poll interrupted by shutdown; the runner is stopping',
          },
          {
            event: 'briefing.poll.failed',
            message: `briefing poll failed (${consecutiveFailures} in a row); retrying in ${Math.round(wait / 1000)}s`,
            retryInMs: wait,
          },
          error,
          consecutiveFailures,
        )
        if (running) await pause(wait)
      }
    }
  })()

  return {
    finished,
    async stop() {
      running = false
      wake?.()
      await finished
    },
    health: () => ({ running, lastPollAt, consecutiveFailures }),
  }
}

/**
 * Write one task's briefing now.
 *
 * **Extracted so the slow tick and the tripwire share one path** (#115). The
 * tripwire's whole point is that a detected provider change must not wait for a
 * tick ten times slower than moderation — and a second implementation of *turn a
 * corpus into claims* would be two things that could disagree about what a
 * briefing is, with the fast one written under time pressure.
 *
 * Answers whether it wrote, so both callers count the same way. Never throws: a
 * task whose synthesis fails keeps its flag and is retried next pass, which is
 * the degradation the whole subsystem is built around — a stale briefing that
 * stays in place is a far smaller failure than something wrong being published.
 */
export async function synthesiseNow(
  store: BriefingStore,
  model: Model,
  taskId: TaskId,
  log: Log,
): Promise<SynthesisOutcome> {
  try {
    const task = await store.taskText(taskId)
    if (task === undefined) {
      // The row points at a task that is gone. Nothing to write and nothing to
      // retry — but the flag stays set rather than being cleared, because a task
      // cannot in fact be deleted (`restrict`), so this means something stranger
      // than a race and it should stay visible.
      log.warn(`briefing for ${taskId} names a task that could not be read`, {
        event: 'briefing.task.unreadable',
        taskId,
      })
      return 'failed'
    }

    const corpus = await store.corpus(taskId)
    const { claims, proposed, unsourced, blank, overlong } = await synthesise(
      { task, corpus },
      model,
    )
    await store.write({ taskId, claims, model: model.name })

    /**
     * **A pass that produced no claims writes no row** (`#611`), and the line
     * says which of the two happened rather than reporting *written, 0 claims* —
     * which is what the twelve empty briefings looked like in the log for as
     * long as they existed.
     */
    if (claims.length === 0) {
      log.info(`no briefing for ${taskId}: nothing to say from ${corpus.length} entries`, {
        event: 'briefing.none',
        taskId,
        entries: corpus.length,
      })
    } else {
      log.info(
        `briefing for ${taskId} written from ${corpus.length} entries, ${claims.length} claims`,
        { event: 'briefing.written', taskId, entries: corpus.length, claims: claims.length },
      )
    }

    // **A corpus with entries in it should never produce nothing**, and this is
    // the line that says so out loud. Every entry cleared a moderator who judged
    // that it contains a real observation, so there is something to state; an
    // empty briefing over a non-empty corpus means the synthesis discarded it,
    // and the reader is then told the Colony "found nothing worth passing on"
    // about a task somebody wrote usable advice for.
    //
    // Warned rather than retried. A retry would loop against a prompt that is
    // answering consistently, and the flag is already cleared — what is needed is
    // for a person to read the prompt, which needs the failure to be visible
    // rather than corrected. It cost a production round trip to find this once.
    //
    // **Which of the two it was, said in the line itself** (`#374`). An empty
    // briefing has two causes and they need opposite fixes: a model that
    // answered with nothing is a prompt to rewrite, and a model that answered
    // and had every claim dropped here is a schema or a provider problem. Both
    // used to print this same sentence, so nine empty briefings could not be
    // sorted into the two piles without a production round trip — which is what
    // `#374` had to do, and what nobody should have to do twice.
    if (corpus.length > 0 && claims.length === 0) {
      const because =
        proposed === 0
          ? 'the model proposed no claims at all'
          : `the model proposed ${proposed}, and every one was dropped here ` +
            `(${unsourced} naming no source in the corpus, ${blank} with empty text, ` +
            `${overlong} running past the length bound)`

      log.warn(
        `briefing for ${taskId} is empty over ${corpus.length} moderated entries — ${because}`,
        {
          event: 'briefing.empty',
          taskId,
          entries: corpus.length,
          proposed,
          unsourced,
          blank,
          overlong,
        },
      )
    }

    /**
     * A claim over the bound is worth a line even when others survived (`#729`).
     *
     * The other two drop counts are only reported when the whole briefing came
     * out empty, which is the case `#374` was sorting out. This one is reported
     * whenever it happens, because it is the model ignoring an instruction it
     * was given explicitly and a schema that was supposed to close it — and
     * until now the way that surfaced was a task no citizen could fetch.
     */
    if (overlong > 0) {
      log.warn(`${overlong} claim(s) for ${taskId} ran past the length bound and were dropped`, {
        event: 'briefing.claim.overlong',
        taskId,
        overlong,
        proposed,
      })
    }

    return 'written'
  } catch (error) {
    /**
     * **A provider that could not be reached is not this task's failure**
     * (`#449`). The flag stays set, the next poll writes the briefing, and one
     * occurrence of it is the system working — the rule
     * `packages/verifiers/src/support.ts` already states for a citizen is the
     * same one here: *"A single transient failure that clears on retry is the
     * system working."*
     *
     * So it is a warning with its own event name rather than
     * `briefing.failed` at error, and that distinction is load-bearing rather
     * than cosmetic: `apps/support-triage-runner` reads `error` out of Loki and
     * files one GitHub issue per signature. A connection reset filed as a defect
     * costs a maintainer the read, and — worse — it lands in the same signature
     * as a real synthesis failure, so the issue that is genuinely about a broken
     * briefing arrives already noisy. `#449` is that issue, filed twice for a
     * network hiccup.
     *
     * **The alarm is not lost, it moves up a level.** A provider that is
     * unreachable is unreachable for every task in the batch, so
     * {@link briefingTick} raises it once for the pass rather than once per
     * task, and the runner's existing backoff and `briefing.poll.failed` line
     * take it from there. That is the arrangement `startBriefingRunner`'s own
     * comment already argues for: *"a model that is refusing requests refuses
     * all of them, and retrying each task individually turns one outage into a
     * request storm."*
     */
    if (error instanceof ProviderUnreachable) {
      log.warn(`briefing for ${taskId} deferred — ${error.message}`, {
        event: 'briefing.unreachable',
        taskId,
        endpoint: error.endpoint,
      })
      return 'unreachable'
    }

    log.error(`could not write the briefing for ${taskId}`, error, {
      event: 'briefing.failed',
      taskId,
    })
    return 'failed'
  }
}

/**
 * Write one provider's briefing now (`#831`).
 *
 * {@link synthesiseNow} for providers, down to never throwing and to answering
 * which of the three happened so the caller counts both phases the same way. A
 * provider whose synthesis fails keeps its flag and is retried next pass, and the
 * briefing already stored stays where it is — the degradation contract the whole
 * subsystem is built around, and the one a provider briefing needs most: a stale
 * write-up of a signup form is worth a great deal more than an error where the
 * Atlas entry's guidance should be.
 *
 * There is no `taskText` equivalent to fail on, so this has one fewer failure
 * mode than the task side. A provider cannot be missing: it is the key itself.
 */
export async function synthesiseProviderNow(
  store: ProviderBriefingStore,
  model: Model,
  where: ProviderKey,
  log: Log,
): Promise<SynthesisOutcome> {
  const provider = `${where.kind}/${where.provider}`

  try {
    const corpus = await store.corpus(where)
    const { claims, proposed, unsourced, blank, overlong } = await synthesiseProvider(
      { provider: where, corpus },
      model,
    )
    await store.write({ kind: where.kind, provider: where.provider, claims, model: model.name })

    if (claims.length === 0) {
      log.info(`no briefing for ${provider}: nothing to say from ${corpus.length} walks`, {
        event: 'provider.briefing.none',
        provider,
        walks: corpus.length,
      })
    } else {
      log.info(
        `briefing for ${provider} written from ${corpus.length} walks, ${claims.length} claims`,
        {
          event: 'provider.briefing.written',
          provider,
          walks: corpus.length,
          claims: claims.length,
        },
      )
    }

    /**
     * The two-causes line, on the task side's terms and for its reason (`#374`).
     *
     * A provider with moderated walks and no claims is either a prompt that will
     * not generalise or a schema the model is answering around, and the counters
     * are what separate them. Warned rather than retried: the flag is already
     * cleared and a retry would loop against a model answering consistently.
     */
    if (corpus.length > 0 && claims.length === 0) {
      const because =
        proposed === 0
          ? 'the model proposed no claims at all'
          : `the model proposed ${proposed}, and every one was dropped here ` +
            `(${unsourced} naming no walk in the corpus, ${blank} with empty text, ` +
            `${overlong} running past the length bound)`

      log.warn(
        `briefing for ${provider} is empty over ${corpus.length} moderated walks — ${because}`,
        {
          event: 'provider.briefing.empty',
          provider,
          walks: corpus.length,
          proposed,
          unsourced,
          blank,
          overlong,
        },
      )
    }

    if (overlong > 0) {
      log.warn(`${overlong} claim(s) for ${provider} ran past the length bound and were dropped`, {
        event: 'provider.briefing.claim.overlong',
        provider,
        overlong,
        proposed,
      })
    }

    await describeProviderNow(store, model, where, corpus, log)

    return 'written'
  } catch (error) {
    // A warning with its own event name, never `error`: the triage runner files
    // one issue per error signature, and a connection reset is not a defect. The
    // alarm moves up to `briefingTick`, which raises one throw for a pass that
    // reached nothing at all.
    if (error instanceof ProviderUnreachable) {
      log.warn(`briefing for ${provider} deferred — ${error.message}`, {
        event: 'provider.briefing.unreachable',
        provider,
        endpoint: error.endpoint,
      })
      return 'unreachable'
    }

    log.error(`could not write the briefing for ${provider}`, error, {
      event: 'provider.briefing.failed',
      provider,
    })
    return 'failed'
  }
}

/**
 * Rewrite one playbook's briefing from its moderated note corpus (`#1251`).
 *
 * **Storage is this function's job; synthesis is not.** `synthesisePlaybook`
 * is the pure function `#1250` shipped; this is the call that persists what it
 * returns and is what a note approval or a revision cut reaches for. Failures
 * log and return — a briefing that stays one approval behind is better than
 * one that blocks the note queue.
 */
export async function synthesisePlaybookNow(
  store: PlaybookBriefingStore,
  model: Model,
  playbookId: string,
  log: Log,
): Promise<SynthesisOutcome> {
  try {
    const playbook = await store.subject(playbookId)
    if (playbook === undefined) {
      log.warn(`playbook ${playbookId} vanished before its briefing could be written`, {
        event: 'playbook.briefing.missing',
        playbookId,
      })
      return 'failed'
    }

    const corpus = await store.corpus(playbookId)
    const { claims, proposed, unsourced, blank, overlong } = await synthesisePlaybook(
      { playbook, corpus },
      model,
    )
    await store.write(playbookId, claims, playbook.revision)

    if (claims.length === 0) {
      log.info(
        `no briefing for playbook ${playbookId}: nothing to say from ${corpus.length} notes`,
        {
          event: 'playbook.briefing.none',
          playbookId,
          notes: corpus.length,
        },
      )
    } else {
      log.info(
        `briefing for playbook ${playbookId} written from ${corpus.length} notes, ${claims.length} claims`,
        {
          event: 'playbook.briefing.written',
          playbookId,
          notes: corpus.length,
          claims: claims.length,
        },
      )
    }

    if (corpus.length > 0 && claims.length === 0) {
      const because =
        proposed === 0
          ? 'the model proposed no claims at all'
          : `the model proposed ${proposed}, and every one was dropped here ` +
            `(${unsourced} naming no note in the corpus, ${blank} with empty text, ` +
            `${overlong} running past the length bound)`

      log.warn(
        `briefing for playbook ${playbookId} is empty over ${corpus.length} moderated notes — ${because}`,
        {
          event: 'playbook.briefing.empty',
          playbookId,
          notes: corpus.length,
          proposed,
          unsourced,
          blank,
          overlong,
        },
      )
    }

    if (overlong > 0) {
      log.warn(
        `${overlong} claim(s) for playbook ${playbookId} ran past the length bound and were dropped`,
        {
          event: 'playbook.briefing.claim.overlong',
          playbookId,
          overlong,
          proposed,
        },
      )
    }

    return 'written'
  } catch (error) {
    if (error instanceof ProviderUnreachable) {
      log.warn(`briefing for playbook ${playbookId} deferred — ${error.message}`, {
        event: 'playbook.briefing.unreachable',
        playbookId,
        endpoint: error.endpoint,
      })
      return 'unreachable'
    }

    log.error(`could not write the briefing for playbook ${playbookId}`, error, {
      event: 'playbook.briefing.failed',
      playbookId,
    })
    return 'failed'
  }
}

/**
 * Write the one sentence saying what a provider is (`#1120`).
 *
 * **On the pass that already rebuilt the briefing** (`#1120`, 11), so nothing
 * schedules this: what makes a description stale is a corpus that moved, which is
 * the same thing that makes a briefing stale, and a second cadence would be a
 * second thing to get wrong about the same evidence.
 *
 * **It swallows its own failures, and that is the point of it being a function.**
 * The briefing is written by the time this runs. A description is the smaller
 * artefact of the two, and losing a briefing that was already synthesised — paid
 * for, correct, and about to be served — because a second model call timed out
 * would be the wrong trade in every direction. So this never throws and never
 * changes the outcome the caller reports; it logs and the next pass tries again.
 *
 * **Nothing is written where there is nothing to say.** An empty corpus, a
 * sentence naming no walk, a blank one and one past the bound all leave the column
 * exactly as it was — an old description written from evidence that has not gone
 * anywhere beats no description, and it certainly beats a truncated one.
 */
async function describeProviderNow(
  store: ProviderBriefingStore,
  model: Model,
  where: ProviderKey,
  corpus: readonly ProviderBriefingSource[],
  log: Log,
): Promise<void> {
  const provider = `${where.kind}/${where.provider}`

  try {
    const { description, proposed, unsourced, blank, overlong } = await describeProvider(
      { provider: where, corpus },
      model,
    )

    if (description === null) {
      if (corpus.length > 0) {
        log.warn(`no description for ${provider} over ${corpus.length} walks`, {
          event: 'provider.description.none',
          provider,
          walks: corpus.length,
          proposed,
          unsourced,
          blank,
          overlong,
        })
      }
      return
    }

    const written = await store.describe({ ...where, description })

    log.info(
      written
        ? `description for ${provider} written from ${corpus.length} walks`
        : `description for ${provider} dropped — the provider has no Atlas entry`,
      {
        event: written ? 'provider.description.written' : 'provider.description.unentered',
        provider,
        walks: corpus.length,
      },
    )
  } catch (error) {
    log.warn(
      `could not describe ${provider} — ${error instanceof Error ? error.message : String(error)}`,
      { event: 'provider.description.failed', provider },
    )
  }
}
