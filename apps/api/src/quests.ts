import {
  AuditDecisionSchema,
  QUEST_AUDIT_OFF,
  QuestDraftSchema,
  QuestPatchSchema,
  QuestRefusalSchema,
  QuestReportSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  questSubmissionRejection,
  type AgentId,
  type ApiError,
  type QuestAuditPolicy,
  type QuestReportCounts,
  type QuestReportKind,
  type SubmissionId,
  type Task,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import {
  createQuestDraft as createQuestDraftInDatabase,
  listOwnQuests as listOwnQuestsInDatabase,
  ownQuestAnswer as ownQuestAnswerInDatabase,
  questAnswerCounts as questAnswerCountsInDatabase,
  questAuditQueue as questAuditQueueInDatabase,
  questDisagreementRate as questDisagreementRateInDatabase,
  questResults as questResultsInDatabase,
  fileQuestReport as fileQuestReportInDatabase,
  questReportCounts as questReportCountsInDatabase,
  retireQuestEarly as retireQuestEarlyInDatabase,
  sponsorQuestReports as sponsorQuestReportsInDatabase,
  colonyNumbers as colonyNumbersInDatabase,
  reviewQueueForSteward as reviewQueueForStewardInDatabase,
  recordAuditDecision as recordAuditDecisionInDatabase,
  publishQuest as publishQuestInDatabase,
  questReviewQueue as questReviewQueueInDatabase,
  readOwnQuest as readOwnQuestInDatabase,
  availableBalance,
  countAudience,
  refuseQuest as refuseQuestInDatabase,
  submitQuestForReview as submitQuestForReviewInDatabase,
  updateQuestDraft as updateQuestDraftInDatabase,
  type AudienceCriteria,
  type Database,
  type OwnQuest,
  type QuestPublishOutcome,
  type QuestRefuseOutcome,
  type AuditCandidate,
  type AuditRecordOutcome,
  type QuestResult as AcceptedReport,
  type FileQuestReportOutcome,
  type QuestSubmitOutcome,
  type QuestWriteOutcome,
  type ColonyNumbers,
  type QuestUnderReview,
  type RetireQuestOutcome,
  type SponsorQuestReport,
} from '@kolonie-ai/db'

/**
 * Writing a quest, reviewing one, and publishing it (`#176`).
 *
 * **Every route here is reachable with a session or an API key, indifferently**
 * (`#172`). That is the mission rather than a convenience: an agent must be able
 * to do everything a human sponsor can, and a surface that quietly required a
 * browser would be the place where that stopped being true. Nothing in this file
 * reads the credential kind, and `callerFor` is what makes that hold.
 */

/** Everything the quest surface needs from the outside world. */
export interface QuestDesk {
  create(input: { readonly authorId: AgentId; readonly draft: unknown }): Promise<OwnQuest>
  update(input: {
    readonly authorId: AgentId
    readonly taskId: TaskId
    readonly patch: unknown
    readonly at: Timestamp
  }): Promise<QuestWriteOutcome>
  submit(input: {
    readonly authorId: AgentId
    readonly taskId: TaskId
    readonly at: Timestamp
  }): Promise<QuestSubmitOutcome>
  /**
   * What this sponsor may still commit: its balance minus what it has reserved
   * (`#174`).
   *
   * On the quest desk rather than on a ledger desk of its own, because the only
   * question anybody asks it here is *can this sponsor afford this quest* — and
   * `#180` requires the answer to be visible in the form **before** submission
   * rather than discovered at publication.
   */
  balance(authorId: AgentId): Promise<{
    readonly balance: number
    readonly reserved: number
    readonly available: number
  }>
  /**
   * How many citizens this targeting could reach today (`#227`).
   *
   * On the quest desk beside `balance` and for the same reason `#180` put the
   * balance there: a sponsor is choosing an audience, and a criterion whose
   * effect on the audience is invisible until publication is a trap. The
   * criteria are passed rather than the quest, so the same question can be asked
   * of a draft that has not been written yet.
   */
  audience(criteria: AudienceCriteria): Promise<number>
  listOwn(authorId: AgentId): Promise<readonly OwnQuest[]>
  readOwn(authorId: AgentId, taskId: TaskId): Promise<OwnQuest | undefined>
  reviewQueue(): Promise<readonly Task[]>
  publish(input: {
    readonly stewardId: AgentId
    readonly taskId: TaskId
    readonly at: Timestamp
  }): Promise<QuestPublishOutcome>
  refuse(input: {
    readonly stewardId: AgentId
    readonly taskId: TaskId
    readonly reason: string
    readonly at: Timestamp
  }): Promise<QuestRefuseOutcome>
  /** The accepted reports on one quest (`#178`). */
  results(taskId: TaskId): Promise<readonly AcceptedReport[]>
  /** Counts per option, for the closed questions only. */
  counts(taskId: TaskId): Promise<Readonly<Record<string, Readonly<Record<string, number>>>>>
  /** One citizen's own answers, in the shape the sponsor gets. */
  ownAnswer(input: {
    readonly taskId: TaskId
    readonly agentId: AgentId
  }): Promise<AcceptedReport | undefined>
  /** The verdicts drawn for a second reading (`#221`). */
  auditQueue(): Promise<readonly AuditCandidate[]>
  /** What a steward found. It changes nothing else. */
  audit(input: {
    readonly submissionId: SubmissionId
    readonly stewardId: AgentId
    readonly agrees: boolean
    readonly reason: string
  }): Promise<AuditRecordOutcome>
  /** How often the judge has been overruled lately. */
  disagreement(): Promise<{ readonly rate: number; readonly audited: number }>
  /**
   * A citizen says something about a quest without completing it (`#240`).
   *
   * On this desk rather than on the guidance desk, deliberately: a task report
   * is published to other citizens through a briefing and a quest report is
   * published to nobody, and putting them behind one port is the first step
   * towards one of them being served where the other belongs.
   */
  report(input: {
    readonly taskId: TaskId
    readonly agentId: AgentId
    readonly kind: QuestReportKind
    readonly text: string
  }): Promise<FileQuestReportOutcome>
  /** The scrubbed `unclear` and `feedback` text, for the sponsor and the steward. */
  reports(taskId: TaskId): Promise<readonly SponsorQuestReport[]>
  /** Claims, accepted reports, and the two counts — visible while the quest runs. */
  reportCounts(taskId: TaskId): Promise<QuestReportCounts>
  /** A steward retires a quest early on that evidence; the escrow refunds by `#174`. */
  retire(taskId: TaskId): Promise<RetireQuestOutcome>
  /**
   * The review queue with everything needed to decide a quest on one screen
   * (`#181`).
   *
   * It takes the reader's id because one of the things shown is *you wrote
   * this*: a steward's own quests appear in the queue, marked and not
   * actionable, rather than being filtered out.
   */
  stewardQueue(stewardId: AgentId): Promise<readonly QuestUnderReview[]>
  /** The Colony's own numbers, each with the moment it was computed (`#181`). */
  numbers(): Promise<ColonyNumbers>
}

/** The quest desk, backed by Postgres. */
export function databaseQuests(db: Database, audit: QuestAuditPolicy = QUEST_AUDIT_OFF): QuestDesk {
  return {
    create: (input) =>
      createQuestDraftInDatabase(db, {
        authorId: input.authorId,
        draft: QuestDraftSchema.parse(input.draft),
      }),
    update: (input) =>
      updateQuestDraftInDatabase(db, {
        authorId: input.authorId,
        taskId: input.taskId,
        patch: QuestPatchSchema.parse(input.patch),
        at: input.at,
      }),
    submit: (input) => submitQuestForReviewInDatabase(db, input),
    balance: (authorId) => availableBalance(db, authorId),
    audience: (criteria) => countAudience(db, criteria),
    listOwn: (authorId) => listOwnQuestsInDatabase(db, authorId),
    readOwn: (authorId, taskId) => readOwnQuestInDatabase(db, authorId, taskId),
    reviewQueue: () => questReviewQueueInDatabase(db),
    publish: (input) => publishQuestInDatabase(db, { ...input, audit }),
    refuse: (input) => refuseQuestInDatabase(db, input),
    results: (taskId) => questResultsInDatabase(db, taskId),
    counts: (taskId) => questAnswerCountsInDatabase(db, taskId),
    ownAnswer: (input) => ownQuestAnswerInDatabase(db, input),
    auditQueue: () => questAuditQueueInDatabase(db, audit),
    audit: (input) => recordAuditDecisionInDatabase(db, input),
    disagreement: () => questDisagreementRateInDatabase(db, audit),
    report: (input) => fileQuestReportInDatabase(db, input),
    reports: (taskId) => sponsorQuestReportsInDatabase(db, taskId),
    reportCounts: (taskId) => questReportCountsInDatabase(db, taskId),
    retire: (taskId) => retireQuestEarlyInDatabase(db, taskId),
    stewardQueue: (stewardId) => reviewQueueForStewardInDatabase(db, stewardId),
    numbers: () => colonyNumbersInDatabase(db),
  }
}

/**
 * File a quest report, and say what happened in the citizen's own terms
 * (`#240`).
 *
 * **The refusals are two and both are about the request.** An unknown quest, and
 * a body that is not one of the three kinds — the second is the schema's, so it
 * never reaches here. There is no refusal about the citizen: any of the three
 * may be filed by somebody that only read the quest, and `unclear` in particular
 * is most valuable from a citizen that never claimed.
 */
export async function fileQuestReport(
  agentId: AgentId,
  input: unknown,
  desk: QuestDesk,
): Promise<{ readonly filed: true; readonly replaced: boolean } | { readonly error: ApiError }> {
  const parsed = QuestReportSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error: {
        code: 'validation_failed',
        message:
          'A quest report carries a `taskId`, a `kind` of `unclear`, `feedback` or `declined`, ' +
          'and the text you want to say.',
      },
    }
  }

  const result = await desk.report({
    taskId: TaskIdSchema.parse(parsed.data.taskId),
    agentId,
    kind: parsed.data.kind,
    text: parsed.data.text,
  })

  if (result.outcome === 'unknown-quest') {
    return {
      error: {
        code: 'not_found',
        message:
          'No quest with that id. This channel is for quests — an Academy rung takes ' +
          '`kolonie.tasks.report` instead.',
      },
    }
  }

  return { filed: true, replaced: result.replaced }
}

/**
 * What a sponsor is told about its own quest.
 *
 * The task as everybody else would read it, plus the two things only its author
 * is entitled to: why a steward refused it, and whether it is still waiting on
 * the moderation stage. The second is there so a sponsor watching a quest that
 * has not reached the queue is not left wondering whether anything is happening.
 */
export interface OwnQuestResponse {
  readonly quest: Task
  readonly rejectionReason: string | null
  readonly awaitingModeration: boolean
}

export type QuestResult<T> =
  | { readonly outcome: 'ok'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

const invalid = (message: string): ApiError => ({ code: 'validation_failed', message })

/**
 * *No such quest* and *not yours* are one answer, deliberately.
 *
 * A distinguishable refusal would let anybody holding a credential enumerate
 * which task ids are quests and who owns them — the same argument the sign-in
 * route makes about a known address, and the reason `readOwnTicket` answers one
 * way too.
 */
const NO_SUCH_QUEST: ApiError = {
  code: 'not_found',
  message: 'No quest of yours has that id.',
}

const notFound = <T>(): QuestResult<T> => ({ outcome: 'rejected', error: NO_SUCH_QUEST })

const respond = (quest: OwnQuest): OwnQuestResponse => ({
  quest: quest.task,
  rejectionReason: quest.rejectionReason,
  awaitingModeration: quest.awaitingModeration,
})

/** Write a new draft. */
export async function writeQuestDraft(
  input: { readonly authorId: AgentId; readonly body: unknown },
  desk: QuestDesk,
): Promise<QuestResult<OwnQuestResponse>> {
  const parsed = QuestDraftSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        'A quest carries a title, a description, instructions, a reward, the number of ' +
          'citizens it is for, and the moment it expires.',
      ),
    }
  }

  const quest = await desk.create({ authorId: input.authorId, draft: parsed.data })
  return { outcome: 'ok', response: respond(quest) }
}

/** Change a draft, or correct a refused quest. */
export async function editQuestDraft(
  input: {
    readonly authorId: AgentId
    readonly questId: string | undefined
    readonly body: unknown
    readonly at: Timestamp
  },
  desk: QuestDesk,
): Promise<QuestResult<OwnQuestResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const parsed = QuestPatchSchema.safeParse(input.body)
  if (!parsed.success) {
    return { outcome: 'rejected', error: invalid('That is not a change a quest accepts.') }
  }

  const result = await desk.update({
    authorId: input.authorId,
    taskId,
    patch: parsed.data,
    at: input.at,
  })

  switch (result.outcome) {
    case 'written':
      return { outcome: 'ok', response: respond(result.quest) }
    case 'not-editable':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message: frozen(result.status),
        },
      }
    default:
      return notFound()
  }
}

/** Submit a draft for review. */
export async function submitQuest(
  input: {
    readonly authorId: AgentId
    readonly questId: string | undefined
    readonly at: Timestamp
    /** Injected so the expiry boundary is testable without waiting for one. */
    readonly now?: Date | undefined
  },
  desk: QuestDesk,
): Promise<QuestResult<OwnQuestResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const own = await desk.readOwn(input.authorId, taskId)
  if (own === undefined) return notFound()

  /**
   * The expiry is judged here rather than in storage, because this is where the
   * sentence is written. A draft written last week and submitted today has to be
   * judged against today — `questSubmissionRejection` takes the moment as an
   * argument for exactly that reason.
   *
   * The column is nullable because an Academy rung never expires; a quest with
   * nothing in it is a draft that was written before the field was required, and
   * it is refused rather than defaulted.
   */
  if (own.task.expiresAt === null) {
    return {
      outcome: 'rejected',
      error: invalid('A quest states when it ends: set `expiresAt` before submitting it.'),
    }
  }

  const rejection = questSubmissionRejection(
    {
      expiresAt: own.task.expiresAt,
      slots: own.task.slots ?? 0,
      reward: own.task.reward,
    },
    input.now ?? new Date(),
  )
  if (rejection !== undefined) {
    return { outcome: 'rejected', error: invalid(rejection) }
  }

  const result = await desk.submit({ authorId: input.authorId, taskId, at: input.at })

  switch (result.outcome) {
    case 'submitted':
      return { outcome: 'ok', response: respond(result.quest) }
    case 'not-editable':
      return { outcome: 'rejected', error: { code: 'conflict', message: frozen(result.status) } }
    case 'queue-occupied':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `Quest ${result.by} of yours is already waiting for review, and an account may ` +
            'have one at a time. Wait for that decision, or withdraw it.',
        },
      }
    case 'insufficient-funds':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `This quest commits ${result.shortfall} credit(s) more than your balance has ` +
            'left after what you have already committed.',
        },
      }
    default:
      return notFound()
  }
}

/** Everything this account has written. */
export async function listQuests(
  authorId: AgentId,
  desk: QuestDesk,
): Promise<QuestResult<{ readonly quests: readonly OwnQuestResponse[] }>> {
  const quests = await desk.listOwn(authorId)
  return { outcome: 'ok', response: { quests: quests.map(respond) } }
}

/** One of this account's own quests. */
export async function readQuest(
  input: { readonly authorId: AgentId; readonly questId: string | undefined },
  desk: QuestDesk,
): Promise<QuestResult<OwnQuestResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const quest = await desk.readOwn(input.authorId, taskId)
  if (quest === undefined) return notFound()

  return { outcome: 'ok', response: respond(quest) }
}

/** The steward's queue: moderated quests awaiting a human decision. */
export async function readReviewQueue(
  desk: QuestDesk,
): Promise<QuestResult<{ readonly quests: readonly Task[] }>> {
  return { outcome: 'ok', response: { quests: await desk.reviewQueue() } }
}

/** Publish a quest, moving its escrow in the same transaction. */
export async function publishQuest(
  input: {
    readonly stewardId: AgentId
    readonly questId: string | undefined
    readonly at: Timestamp
  },
  desk: QuestDesk,
): Promise<QuestResult<{ readonly escrowed: number }>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const result = await desk.publish({ stewardId: input.stewardId, taskId, at: input.at })

  switch (result.outcome) {
    case 'published':
      return { outcome: 'ok', response: { escrowed: result.escrowed } }
    case 'unknown-quest':
      return notFound()
    case 'not-in-review':
      return {
        outcome: 'rejected',
        error: { code: 'conflict', message: notInReview(result.status) },
      }
    case 'own-quest':
      return { outcome: 'rejected', error: SELF_APPROVAL }
    case 'awaiting-moderation':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message: 'This quest has not cleared moderation yet, so it is not yours to publish.',
        },
      }
    case 'insufficient-funds':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `Its author is ${result.shortfall} credit(s) short of what this quest commits, ` +
            'so publishing it would escrow money that is not there.',
        },
      }
    case 'audit-missing':
      return { outcome: 'rejected', error: { code: 'conflict', message: result.reason } }
  }
}

/** The audit queue, for a steward. */
export async function readAuditQueue(desk: QuestDesk): Promise<
  QuestResult<{
    readonly disagreement: { readonly rate: number; readonly audited: number }
    readonly verdicts: readonly AuditCandidate[]
  }>
> {
  return {
    outcome: 'ok',
    response: { disagreement: await desk.disagreement(), verdicts: await desk.auditQueue() },
  }
}

/** Record what a steward found on re-reading a verdict. */
export async function recordAudit(
  input: {
    readonly stewardId: AgentId
    readonly submissionId: string | undefined
    readonly body: unknown
  },
  desk: QuestDesk,
): Promise<QuestResult<{ readonly recorded: true }>> {
  const parsed = AuditDecisionSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        'An audit carries `agrees` and a `reason`, and the reason is required either way: a ' +
          'steward asked for one only when it disagrees learns that the field means disagreement.',
      ),
    }
  }

  const submissionId = SubmissionIdSchema.safeParse(input.submissionId)
  if (!submissionId.success) {
    return { outcome: 'rejected', error: { code: 'not_found', message: 'No such verdict.' } }
  }

  const result = await desk.audit({
    submissionId: submissionId.data,
    stewardId: input.stewardId,
    agrees: parsed.data.agrees,
    reason: parsed.data.reason,
  })

  switch (result.outcome) {
    case 'recorded':
      return { outcome: 'ok', response: { recorded: true } }
    case 'unknown-submission':
      return { outcome: 'rejected', error: { code: 'not_found', message: 'No such verdict.' } }
    case 'already-audited':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message: 'Another steward has already read this one.',
        },
      }
  }
}

/** Refuse a quest, with a reason its author reads. */
export async function refuseQuest(
  input: {
    readonly stewardId: AgentId
    readonly questId: string | undefined
    readonly body: unknown
    readonly at: Timestamp
  },
  desk: QuestDesk,
): Promise<QuestResult<{ readonly refused: true }>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const parsed = QuestRefusalSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        'A refusal carries a `reason`, and it is written for the sponsor to act on: ' +
          'a quest that is nearly right is refused with what would make it right.',
      ),
    }
  }

  const result = await desk.refuse({
    stewardId: input.stewardId,
    taskId,
    reason: parsed.data.reason,
    at: input.at,
  })

  switch (result.outcome) {
    case 'refused':
      return { outcome: 'ok', response: { refused: true } }
    case 'unknown-quest':
      return notFound()
    case 'not-in-review':
      return {
        outcome: 'rejected',
        error: { code: 'conflict', message: notInReview(result.status) },
      }
    case 'own-quest':
      return { outcome: 'rejected', error: SELF_APPROVAL }
  }
}

/**
 * The refusal a steward gets for its own quest.
 *
 * Named, unlike `UNPRIVILEGED`, because it is not an oracle: the caller already
 * knows it wrote this quest, and telling it why it cannot act saves it from
 * concluding its role was revoked.
 */
const SELF_APPROVAL: ApiError = {
  code: 'forbidden',
  message:
    'Nobody decides their own quest. Another steward publishes or refuses this one ' +
    '(kolonie-platform#173).',
}

const frozen = (status: Task['status']): string =>
  `This quest is ${status}, and only a draft or a refused quest is yours to change.`

const notInReview = (status: Task['status']): string =>
  `This quest is ${status}, and only a quest awaiting review can be decided.`

/**
 * The id, or nothing.
 *
 * An unparseable id is the same answer as an unknown one, for the reason
 * {@link NO_SUCH_QUEST} gives — and because a `400` here would tell a caller
 * that a well-formed id it does not own is a *different* kind of wrong from a
 * malformed one.
 */
function questIdFrom(value: string | undefined): TaskId | undefined {
  const parsed = TaskIdSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * What the sponsor's read answers with (`#178`).
 *
 * **Exactly these keys, and a test asserts the serialised payload carries no
 * other.** The list of what is absent is in `QuestResult`'s own comment and in
 * a test per item, because a denylist that is not written down is not enforced.
 */
export interface QuestResultsResponse {
  readonly quest: { readonly id: TaskId; readonly title: string }
  readonly accepted: number
  readonly results: readonly AcceptedReport[]
  /** Counts per option, for closed questions. Empty when the quest asks none. */
  readonly counts: Readonly<Record<string, Readonly<Record<string, number>>>>
  /**
   * What citizens said about the quest itself (`#240`).
   *
   * **The counts are here on the results page rather than behind a second call**,
   * because a sponsor reading fifty accepted answers and eight `unclear` reports
   * on the same screen is the diagnosis; a sponsor that has to go looking for the
   * second number never does.
   */
  readonly reportCounts: QuestReportCounts
  /**
   * The `unclear` and `feedback` text, scrubbed and attributed to nobody.
   *
   * **`declined` is in `reportCounts` and is not here, in any form.** See
   * `sponsorQuestReports` in `packages/db` for the three separate defences that
   * make that true rather than remembered.
   */
  readonly reports: readonly SponsorQuestReport[]
}

/**
 * The accepted reports, for the quest's author and nobody else.
 *
 * **Authorised by authorship rather than by a role.** A steward may publish a
 * quest and may not read its answers: reviewing what may be asked and reading
 * what was answered are different powers, and the second was sold to one party.
 */
export async function readQuestResults(
  input: { readonly authorId: AgentId; readonly questId: string | undefined },
  desk: QuestDesk,
): Promise<QuestResult<QuestResultsResponse>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const own = await desk.readOwn(input.authorId, taskId)
  if (own === undefined) return notFound()

  const results = await desk.results(taskId)

  return {
    outcome: 'ok',
    response: {
      quest: { id: own.task.id, title: own.task.title },
      accepted: results.length,
      results,
      counts: await desk.counts(taskId),
      reportCounts: await desk.reportCounts(taskId),
      reports: await desk.reports(taskId),
    },
  }
}

/**
 * The same set as a file: CSV or JSON.
 *
 * **From the first version, because the whole value is the set.** An interface
 * that can only be read one row at a time has not delivered the product.
 *
 * The two carry exactly the fields the read view carries — the export is the
 * place a forgotten scrub or a stray column would actually leak, since nobody
 * reads a thousand rows by eye.
 */
export async function exportQuestResults(
  input: {
    readonly authorId: AgentId
    readonly questId: string | undefined
    readonly format: string | undefined
  },
  desk: QuestDesk,
): Promise<
  | { readonly outcome: 'ok'; readonly contentType: string; readonly body: string }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
> {
  const format = input.format ?? 'json'
  if (format !== 'json' && format !== 'csv') {
    return {
      outcome: 'rejected',
      error: invalid('An export is `csv` or `json`.'),
    }
  }

  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return { outcome: 'rejected', error: NO_SUCH_QUEST }

  const own = await desk.readOwn(input.authorId, taskId)
  if (own === undefined) return { outcome: 'rejected', error: NO_SUCH_QUEST }

  const results = await desk.results(taskId)
  const keys = own.task.questions.map((question) => question.key)

  if (format === 'json') {
    return {
      outcome: 'ok',
      contentType: 'application/json',
      body: JSON.stringify({ results }, null, 2),
    }
  }

  const header = ['handle', 'runtime', 'acceptedAt', ...keys]
  const lines = [
    header.map(csvCell).join(','),
    ...results.map((result) =>
      [
        result.handle ?? '',
        result.runtime ?? '',
        result.acceptedAt,
        ...keys.map((key) => result.answers[key] ?? ''),
      ]
        .map(csvCell)
        .join(','),
    ),
  ]

  return { outcome: 'ok', contentType: 'text/csv', body: lines.join('\n') }
}

/**
 * One cell, quoted the way every CSV reader expects.
 *
 * Written out rather than taken from a library: the whole of the format is
 * *double the quotes and wrap anything containing a comma, a quote or a
 * newline*, and a dependency for six lines is a dependency to keep patched.
 */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** A citizen's own answers, exactly as the sponsor sees them. */
export async function readOwnAnswer(
  input: { readonly agentId: AgentId; readonly questId: string | undefined },
  desk: QuestDesk,
): Promise<QuestResult<AcceptedReport>> {
  const taskId = questIdFrom(input.questId)
  if (taskId === undefined) return notFound()

  const answer = await desk.ownAnswer({ taskId, agentId: input.agentId })
  if (answer === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'You have no accepted report on that quest. An answer becomes readable when it is ' +
          'accepted, which is also when it is paid.',
      },
    }
  }

  return { outcome: 'ok', response: answer }
}

/** The variable that switches the audit on. Off unless it says `true`. */
export const QUEST_AUDIT_VAR = 'QUEST_AUDIT_ENABLED'
export const QUEST_AUDIT_RATE_VAR = 'QUEST_AUDIT_RATE'

/**
 * The audit policy this process runs under (`#221`).
 *
 * **Off unless the variable says otherwise, and the default is the safe one on
 * purpose** — a deployment that has not thought about the audit refuses to
 * publish paid quests rather than publishing them unguarded. The same shape of
 * default `tasks.kind` has: a writer that says nothing gets the kind that cannot
 * mint.
 *
 * A rate that does not parse is the default rate rather than an error. The
 * failure it would otherwise cause is the API refusing to start over a typo in
 * a number that has a sensible value, and the switch above is the part that
 * matters.
 */
export function questAuditPolicy(env: NodeJS.ProcessEnv = process.env): QuestAuditPolicy {
  const rate = Number.parseFloat(env[QUEST_AUDIT_RATE_VAR] ?? '')

  return {
    ...QUEST_AUDIT_OFF,
    enabled: env[QUEST_AUDIT_VAR] === 'true',
    ...(Number.isFinite(rate) && rate > 0 && rate <= 1 && { rate }),
  }
}
