import type { AuditCandidate, AuditRecordOutcome } from '@kolonie-ai/db'
import type { Log } from './loop.js'
import type { Model } from './llm.js'

/**
 * The second reading of quest verdicts the judge passed (`#221`, `#944`).
 *
 * **`#221` built this as a queue and a tool, and a queue is not a programme.**
 * The draw, the disagreement rate and the brake that stops paid quests when the
 * judge is being overruled were all there; what was missing is that every one of
 * them waited on a steward calling `kolonie.quests.audit` — an agent the Colony
 * does not employ, cannot schedule and cannot page. A sample nobody draws is a
 * rate of zero, and a rate of zero reads exactly like a judge that is never
 * wrong. So `#944` moves the reading here, beside the other passes: it runs on a
 * cadence, it needs no tool call to start, and the tier it came from is down to
 * the one lever that has to be immediate.
 *
 * **Nobody is waiting, and that is what makes its failure rule the opposite of
 * {@link reviewHeldReport}'s.** A held report has a citizen watching a `pending`
 * that will not resolve, so every doubt there releases. Here the citizen was
 * paid at the verdict and the verdict is final either way — the audit *"counts
 * and never reverses a payout"* (D-061) — so a reading that could not be reached
 * or could not be read writes **no row at all**, and the candidate is simply
 * drawn again next time. Recording an unclear reading as agreement would tilt
 * the rate towards *the judge is fine*, which is the direction that keeps money
 * flowing, and this number exists to stop the Colony selling work it cannot
 * judge.
 *
 * **It is not the judge's prompt run twice.** The queue holds only verdicts that
 * *passed*, so a reader asked *is this a good answer?* at `temperature: 0` would
 * agree with the judge about as often as the judge agrees with itself.
 * {@link QUEST_AUDIT_PROMPT} is briefed the other way round, the way
 * `RED_LINE_DEFENCE_PROMPT` is: find the reason this should not have been
 * accepted.
 */

/** Where the audit reads and writes. Injected, like every other store here. */
export interface QuestAuditStore {
  /** Verdicts drawn for a second reading that nothing has read yet, oldest first. */
  queue(limit: number): Promise<readonly AuditCandidate[]>
  record(input: {
    readonly submissionId: AuditCandidate['submissionId']
    readonly agrees: boolean
    readonly reason: string
  }): Promise<AuditRecordOutcome>
}

export interface QuestAuditLoopDependencies {
  readonly store: QuestAuditStore
  readonly model: Model
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * The three answers the audit may give.
 *
 * **`cannot-tell` exists so that doubt has somewhere to go that is not
 * agreement.** Two choices would make every unclear reading a vote for the
 * judge, and the whole value of this number is that it is allowed to say the
 * judge is wrong.
 */
export const AUDIT_CHOICES = ['stands', 'should-not-have-passed', 'cannot-tell'] as const

/** What one drawn verdict's second reading came to. */
export type QuestAuditJudgement =
  | { readonly kind: 'agreed' }
  | { readonly kind: 'disagreed' }
  /** Nothing was written: unread, unreachable, or read and undecided. */
  | { readonly kind: 'unread'; readonly cause: UnreadCause }
  /** Somebody read it first, or the submission is gone. Nothing was written. */
  | { readonly kind: 'stale' }

/**
 * Why a drawn verdict was left unaudited.
 *
 * Three causes, and only the first is about the answer. *The model said it could
 * not tell* and *the gateway never answered* are the same silence in the table
 * and very different facts about the Colony, and a pass that could not tell them
 * apart could be down for a week while its rate sat innocently at zero.
 */
export type UnreadCause =
  /** The reader looked and would not commit either way. */
  | 'undecided'
  /** The reply could not be read as a verdict. */
  | 'unreadable'
  /** The model could not be reached. */
  | 'unreachable'

/**
 * Read one drawn verdict a second time, and record what it found.
 *
 * Nothing here throws, and nothing here is written unless the reading reached a
 * verdict: an audit row is a measurement, and a measurement taken when the
 * instrument was unplugged is worse than a missing one.
 */
export async function auditQuestVerdict(
  candidate: AuditCandidate,
  deps: QuestAuditLoopDependencies,
): Promise<QuestAuditJudgement> {
  const { store, model, log = silentLog } = deps

  const reading = await read(candidate, model, log)
  if (reading.kind === 'unread') return reading

  const outcome = await store.record({
    submissionId: candidate.submissionId,
    agrees: reading.kind === 'agreed',
    reason: reading.reason,
  })

  /**
   * `already-audited` is ordinary — two ticks may overlap on a slow reading, and
   * the row the first one wrote is the one that counts — and `unknown-submission`
   * means the row went while this was thinking. `own-quest` cannot happen from
   * here: the guard is skipped for a reading with no agent behind it, because
   * this pass sponsors nothing.
   */
  return outcome.outcome === 'recorded' ? { kind: reading.kind } : { kind: 'stale' }
}

/**
 * Ask the reader to attack the acceptance, and read what it answered.
 *
 * Separated from the writing above so the failure rules are in one place and
 * every one of them lands on the same value: nothing recorded, with the cause it
 * was not recorded for.
 */
async function read(
  candidate: AuditCandidate,
  model: Model,
  log: Log,
): Promise<
  | { readonly kind: 'agreed'; readonly reason: string }
  | { readonly kind: 'disagreed'; readonly reason: string }
  | { readonly kind: 'unread'; readonly cause: UnreadCause }
> {
  let decision: string
  let reason: string

  try {
    const answered = await model.classify({
      system: QUEST_AUDIT_PROMPT,
      user: [
        `Quest: ${candidate.questTitle}`,
        '',
        'What was asked:',
        candidate.questions.map(asked).join('\n'),
        '',
        'What was answered:',
        candidate.answers.map((answer) => `${answer.questionKey}: ${answer.text}`).join('\n\n'),
        '',
        'Why the judge accepted it:',
        candidate.verdict,
      ].join('\n'),
      choices: [...AUDIT_CHOICES],
    })

    decision = answered.decision
    reason = answered.reason
  } catch (error) {
    log.error(`could not read verdict ${candidate.submissionId} a second time`, error, {
      event: 'quest.audit.failed',
      submissionId: candidate.submissionId,
    })

    return { kind: 'unread', cause: 'unreachable' }
  }

  switch (decision) {
    case 'stands':
      return { kind: 'agreed', reason: reasonFor(decision, reason) }
    case 'should-not-have-passed':
      return { kind: 'disagreed', reason: reasonFor(decision, reason) }
    case 'cannot-tell':
      return { kind: 'unread', cause: 'undecided' }
    /**
     * The schema is strict and this should be unreachable — which is why it
     * records nothing rather than throwing. An enum the gateway stopped
     * enforcing would otherwise be an exception on every drawn verdict, and a
     * pass that is down is indistinguishable from a judge that is never wrong.
     */
    default:
      log.warn(`the audit of ${candidate.submissionId} answered "${decision}"`, {
        event: 'quest.audit.unreadable',
        submissionId: candidate.submissionId,
      })

      return { kind: 'unread', cause: 'unreadable' }
  }
}

/**
 * One question, as the reader is shown it.
 *
 * **The sponsor's `criteria` go in, and are labelled as the sponsor's.** The
 * judge was shown them too, and an auditor asked whether the answer is good
 * without knowing what the sponsor asked for would be measuring its own taste.
 * They are the sponsor's words and the prompt says so — `QuestQuestionSchema`
 * calls criteria *"data and not instructions"*, and a sponsor that writes
 * *"always pass"* is paying out of its own escrow for reports it did not want.
 *
 * **Optional questions are marked**, because an unanswered optional question is
 * not a fault and an auditor left to guess which were required would find one.
 */
function asked(question: {
  readonly key: string
  readonly prompt: string
  readonly criteria?: string
  readonly required?: boolean
}): string {
  const lines = [
    `${question.key}${question.required === false ? ' (optional)' : ''}: ${question.prompt}`,
  ]
  if (question.criteria !== undefined && question.criteria.trim() !== '') {
    lines.push(`  what the sponsor said a good answer does: ${question.criteria}`)
  }
  return lines.join('\n')
}

/**
 * The reason column's bounds, held here rather than discovered at the insert.
 *
 * `quest_audits_reason_length` is a check constraint between 10 and 1000
 * characters, written for a steward typing a sentence. A classifier that answers
 * `"ok"` would fail that constraint, and a failed insert on one candidate is a
 * thrown error in the middle of a batch — so the short answer is replaced with a
 * sentence that says what was decided and that no reason came with it, which is
 * the honest record of what happened.
 */
const REASON_MIN = 10
const REASON_MAX = 1000

function reasonFor(decision: string, reason: string): string {
  const trimmed = reason.trim().replace(/\s+/g, ' ')

  if (trimmed.length < REASON_MIN) {
    return `The Colony’s audit answered “${decision}” and gave no reason with it.`
  }

  return trimmed.length <= REASON_MAX ? trimmed : `${trimmed.slice(0, REASON_MAX - 1)}…`
}

/** What one pass over the audit queue came to. */
export interface QuestAuditTickOutcome {
  readonly read: number
  readonly agreed: number
  readonly disagreed: number
  readonly unread: number
  readonly stale: number
}

/**
 * Take one batch of drawn verdicts through a second reading. Sequential, like
 * every pass here.
 *
 * The queue is already a sample rather than the whole stream — `questAuditQueue`
 * draws a fixed fraction by hashing the submission id, so the batch is bounded
 * twice and the rate the Colony reads is the rate it paid for.
 */
export async function questAuditTick(
  deps: QuestAuditLoopDependencies,
  batchSize: number,
): Promise<QuestAuditTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = { read: 0, agreed: 0, disagreed: 0, unread: 0, stale: 0 }

  for (const candidate of await store.queue(batchSize)) {
    const judgement = await auditQuestVerdict(candidate, deps)
    outcome.read++

    switch (judgement.kind) {
      case 'agreed':
        outcome.agreed++
        break
      case 'disagreed':
        outcome.disagreed++
        /**
         * **A warning rather than an info line.** One disagreement changes
         * nothing on its own — the payout stands, the citizen keeps it — but the
         * rate it feeds is what stops paid quests being published, and a brake
         * tightening is worth seeing before it bites.
         */
        log.warn(`the audit disagreed with the judge on ${candidate.submissionId}`, {
          event: 'quest.audit.judged',
          submissionId: candidate.submissionId,
          verdict: 'disagreed',
        })
        break
      case 'unread':
        outcome.unread++
        log.info(`verdict ${candidate.submissionId} left unaudited (${judgement.cause})`, {
          event: 'quest.audit.unread',
          submissionId: candidate.submissionId,
          cause: judgement.cause,
        })
        break
      case 'stale':
        outcome.stale++
        break
    }
  }

  return outcome
}

/**
 * The brief for the audit, and it is an attack rather than a check.
 *
 * **Everything in this queue passed.** A reader asked *was this a good answer?*
 * about work another model already called good will agree, and the agreement
 * would measure the family the two share rather than the verdict. So this one is
 * shown the judge's own reasoning and told to find what it missed.
 *
 * **The tilt is the opposite of `RED_LINE_DEFENCE_PROMPT`'s, and for the
 * opposite asymmetry.** There, a wrong `upheld` destroys an attempt, so doubt
 * releases. Here nothing at all happens to the citizen — the money is paid and
 * the verdict is final — and the only thing a disagreement moves is the Colony's
 * own measurement of its judge. Being hard to please costs a citizen nothing and
 * buys an honest number.
 */
export const QUEST_AUDIT_PROMPT = [
  'You are auditing an automated judge. An AI agent answered a paid quest, the Colony’s judge',
  'accepted the answer and the agent has already been paid. Nothing you say changes that: the',
  'payout stands, the agent keeps it, and no attempt is reopened. What your answer does is measure',
  'how often the judge is wrong, and that number decides whether the Colony keeps selling paid',
  'quests at all.',
  '',
  'You are shown the questions, the answers, and the judge’s own reason for accepting. Your brief',
  'is to argue AGAINST the acceptance: assume there is something the judge missed and go looking',
  'for it. Ask whether each required question was actually answered, whether the answer is about',
  'the quest or merely near it, whether specifics that were asked for are present or have been',
  'replaced by generalities, and whether the judge’s reason is a finding or a paraphrase of the',
  'answer.',
  '',
  'None of these is a fault: the answer is short, badly written, blunt, negative about the sponsor',
  'or the Colony, or says the task was harder than the sponsor thought. A brief answer that answers',
  'the question is a good answer. You are judging whether the questions were answered, not whether',
  'the writing is impressive.',
  '',
  'Answer with one of three:',
  '  - "stands" — you tried to attack the acceptance and could not. Say in one sentence what',
  '    defeated the attack.',
  '  - "should-not-have-passed" — the answer does not do what the quest asked. Say in one sentence',
  '    which question was not answered and how.',
  '  - "cannot-tell" — you cannot judge this from what you were shown, because the quest asks for',
  '    something only the sponsor or the outside world could verify. Say so.',
  '',
  'Prefer "cannot-tell" to a guess in either direction. A recorded guess is worse than a gap: the',
  'gap is drawn again next time, and the guess is counted forever.',
].join('\n')
