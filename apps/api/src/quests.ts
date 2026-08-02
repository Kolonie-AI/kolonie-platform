import {
  QuestDraftSchema,
  QuestPatchSchema,
  QuestRefusalSchema,
  TaskIdSchema,
  questSubmissionRejection,
  type AgentId,
  type ApiError,
  type Task,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import {
  createQuestDraft as createQuestDraftInDatabase,
  listOwnQuests as listOwnQuestsInDatabase,
  publishQuest as publishQuestInDatabase,
  questReviewQueue as questReviewQueueInDatabase,
  readOwnQuest as readOwnQuestInDatabase,
  refuseQuest as refuseQuestInDatabase,
  submitQuestForReview as submitQuestForReviewInDatabase,
  updateQuestDraft as updateQuestDraftInDatabase,
  type Database,
  type OwnQuest,
  type QuestPublishOutcome,
  type QuestRefuseOutcome,
  type QuestSubmitOutcome,
  type QuestWriteOutcome,
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
}

/** The quest desk, backed by Postgres. */
export function databaseQuests(db: Database): QuestDesk {
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
    listOwn: (authorId) => listOwnQuestsInDatabase(db, authorId),
    readOwn: (authorId, taskId) => readOwnQuestInDatabase(db, authorId, taskId),
    reviewQueue: () => questReviewQueueInDatabase(db),
    publish: (input) => publishQuestInDatabase(db, input),
    refuse: (input) => refuseQuestInDatabase(db, input),
  }
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
