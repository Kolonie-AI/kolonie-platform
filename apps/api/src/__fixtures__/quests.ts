import { randomUUID } from 'node:crypto'
import {
  QUEST_PENDING_LIMIT,
  QUEST_TASK_TYPE,
  QuestDraftSchema,
  QuestPatchSchema,
  TaskIdSchema,
  TaskTypeSchema,
  questCommitment,
  type AgentId,
  type Task,
  type TaskId,
} from '@kolonie-ai/core'
import type { OwnQuest } from '@kolonie-ai/db'
import type { QuestDesk } from '../quests.js'

export interface FakeQuestDesk extends QuestDesk {
  /**
   * Clear the moderation stage, which no route can do.
   *
   * The runner is the only thing that writes a quest's verdict, and it is in
   * another workspace — so without this, every steward test would be testing the
   * refusal rather than the review.
   */
  readonly moderate: (taskId: TaskId, decision?: 'approved' | 'rejected') => void
  /** Credit a sponsor's balance, which is `packages/db`'s job in the real one. */
  readonly credit: (agentId: AgentId, amount: number) => void
}

/**
 * The quest desk, in memory.
 *
 * **It reproduces the four rules the routes are allowed to rely on** rather than
 * answering yes to everything: a quest belongs to its author, an unmoderated
 * quest is invisible to a steward, nobody decides its own quest, and one account
 * occupies the review queue once. A fake that skipped them would let the API
 * tests pass while the SQL leaked — which is the failure a fixture is supposed
 * to make impossible rather than hide.
 *
 * Whether Postgres enforces them is asserted in `packages/db` against a real
 * one. What the API does with the answers is asserted here.
 */
export function fakeQuests(): FakeQuestDesk {
  const quests = new Map<
    string,
    { readonly own: OwnQuest; moderated: 'approved' | 'rejected' | null }
  >()
  const balances = new Map<string, number>()

  const task = (input: {
    readonly id: TaskId
    readonly authorId: AgentId
    readonly draft: ReturnType<typeof QuestDraftSchema.parse>
    readonly status: Task['status']
  }): Task => ({
    id: input.id,
    type: TaskTypeSchema.parse(QUEST_TASK_TYPE),
    kind: 'quest',
    requires: input.draft.requires,
    suggests: [],
    grants: [],
    requiresAccounts: [],
    minReputation: input.draft.minReputation,
    recommendedOrder: 100,
    title: input.draft.title,
    description: input.draft.description,
    instructions: input.draft.instructions,
    reward: input.draft.reward,
    slots: input.draft.slots,
    expiresAt: input.draft.expiresAt,
    audience: input.draft.audience,
    rejectionReason: null,
    assistanceAllowed: input.draft.assistanceAllowed,
    prerequisiteTaskIds: [],
    timeoutHours: input.draft.timeoutHours,
    status: input.status,
    createdBy: input.authorId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const put = (own: OwnQuest, moderated: 'approved' | 'rejected' | null = null): OwnQuest => {
    quests.set(own.task.id, { own, moderated })
    return own
  }

  const mine = (authorId: AgentId, taskId: TaskId) => {
    const held = quests.get(taskId)
    if (held === undefined) return undefined
    return held.own.task.createdBy === authorId ? held : undefined
  }

  const reserved = (authorId: AgentId): number =>
    [...quests.values()]
      .filter(
        (held) => held.own.task.createdBy === authorId && held.own.task.status === 'pending_review',
      )
      .reduce(
        (total, held) =>
          total +
          questCommitment({ reward: held.own.task.reward, slots: held.own.task.slots ?? 0 }),
        0,
      )

  return {
    moderate(taskId, decision = 'approved') {
      const held = quests.get(taskId)
      if (held === undefined) return
      held.moderated = decision
      if (decision === 'rejected') {
        quests.set(taskId, {
          own: {
            task: { ...held.own.task, status: 'rejected' },
            rejectionReason: 'It crosses a red line.',
            awaitingModeration: false,
          },
          moderated: decision,
        })
      }
    },

    credit(agentId, amount) {
      balances.set(agentId, (balances.get(agentId) ?? 0) + amount)
    },

    async create({ authorId, draft }) {
      const parsed = QuestDraftSchema.parse(draft)
      const id = TaskIdSchema.parse(randomUUID())
      return put({
        task: task({ id, authorId, draft: parsed, status: 'draft' }),
        rejectionReason: null,
        awaitingModeration: false,
      })
    },

    async update({ authorId, taskId, patch }) {
      const held = mine(authorId, taskId)
      if (held === undefined) {
        return quests.has(taskId) ? { outcome: 'not-yours' } : { outcome: 'unknown-quest' }
      }

      const { status } = held.own.task
      if (status !== 'draft' && status !== 'rejected') return { outcome: 'not-editable', status }

      const parsed = QuestPatchSchema.parse(patch)
      const updated: OwnQuest = {
        task: {
          ...held.own.task,
          ...(parsed.title !== undefined && { title: parsed.title }),
          ...(parsed.instructions !== undefined && { instructions: parsed.instructions }),
          ...(parsed.description !== undefined && { description: parsed.description }),
          ...(parsed.reward !== undefined && { reward: parsed.reward }),
          ...(parsed.slots !== undefined && { slots: parsed.slots }),
          ...(parsed.expiresAt !== undefined && { expiresAt: parsed.expiresAt }),
        },
        rejectionReason: held.own.rejectionReason,
        awaitingModeration: false,
      }

      return { outcome: 'written', quest: put(updated) }
    },

    async submit({ authorId, taskId }) {
      const held = mine(authorId, taskId)
      if (held === undefined) {
        return quests.has(taskId) ? { outcome: 'not-yours' } : { outcome: 'unknown-quest' }
      }

      const { status } = held.own.task
      if (status !== 'draft' && status !== 'rejected') return { outcome: 'not-editable', status }

      const queued = [...quests.values()].filter(
        (other) =>
          other.own.task.createdBy === authorId && other.own.task.status === 'pending_review',
      )
      const first = queued[0]
      if (queued.length >= QUEST_PENDING_LIMIT && first !== undefined) {
        return { outcome: 'queue-occupied', by: first.own.task.id }
      }

      const wanted = questCommitment({
        reward: held.own.task.reward,
        slots: held.own.task.slots ?? 0,
      })
      const free = (balances.get(authorId) ?? 0) - reserved(authorId)
      if (free < wanted) return { outcome: 'insufficient-funds', shortfall: wanted - free }

      return {
        outcome: 'submitted',
        quest: put(
          {
            task: { ...held.own.task, status: 'pending_review' },
            rejectionReason: null,
            awaitingModeration: true,
          },
          null,
        ),
      }
    },

    async listOwn(authorId) {
      return [...quests.values()]
        .filter((held) => held.own.task.createdBy === authorId)
        .map((held) => held.own)
    },

    async readOwn(authorId, taskId) {
      return mine(authorId, taskId)?.own
    },

    async reviewQueue() {
      return [...quests.values()]
        .filter(
          (held) => held.own.task.status === 'pending_review' && held.moderated === 'approved',
        )
        .map((held) => held.own.task)
    },

    async publish({ stewardId, taskId }) {
      const held = quests.get(taskId)
      if (held === undefined) return { outcome: 'unknown-quest' }
      if (held.own.task.status !== 'pending_review') {
        return { outcome: 'not-in-review', status: held.own.task.status }
      }
      if (held.own.task.createdBy === stewardId) return { outcome: 'own-quest' }
      if (held.moderated !== 'approved') return { outcome: 'awaiting-moderation' }

      const escrowed = questCommitment({
        reward: held.own.task.reward,
        slots: held.own.task.slots ?? 0,
      })

      put(
        {
          task: { ...held.own.task, status: 'active' },
          rejectionReason: null,
          awaitingModeration: false,
        },
        'approved',
      )

      return { outcome: 'published', escrowed }
    },

    async refuse({ stewardId, taskId, reason }) {
      const held = quests.get(taskId)
      if (held === undefined) return { outcome: 'unknown-quest' }
      if (held.own.task.status !== 'pending_review') {
        return { outcome: 'not-in-review', status: held.own.task.status }
      }
      if (held.own.task.createdBy === stewardId) return { outcome: 'own-quest' }

      put(
        {
          task: { ...held.own.task, status: 'rejected' },
          rejectionReason: reason,
          awaitingModeration: false,
        },
        held.moderated,
      )

      return { outcome: 'refused' }
    },
  }
}
