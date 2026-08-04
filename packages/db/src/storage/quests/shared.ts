import { and, eq } from 'drizzle-orm'
import type { AgentId, Task, TaskId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../../client.js'
import { tasks } from '../../schema/index.js'

/** What a sponsor's own quest looks like to it: the task, plus why it was refused. */
export interface OwnQuest {
  readonly task: Task
  /** The steward's reason, on a refused quest and nowhere else. */
  readonly rejectionReason: string | null
  /** Whether this quest is still waiting for the moderation stage (`#176`). */
  readonly awaitingModeration: boolean
}

/** One of this account's quests, or why it is not. */
export async function ownQuestRow(
  db: Database | Transaction,
  authorId: AgentId,
  taskId: TaskId,
): Promise<
  | { readonly outcome: 'found'; readonly row: typeof tasks.$inferSelect }
  | { readonly outcome: 'unknown-quest' }
  | { readonly outcome: 'not-yours' }
> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.kind, 'quest')))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown-quest' }
  if (row.createdBy !== authorId) return { outcome: 'not-yours' }

  return { outcome: 'found', row }
}

/** One answer as the scrub left it. */
export interface ScrubbedAnswer {
  readonly questionKey: string
  readonly text: string
}
