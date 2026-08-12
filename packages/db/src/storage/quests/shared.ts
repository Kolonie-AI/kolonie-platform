import { and, eq } from 'drizzle-orm'
import type { AgentId, Task, TaskId, Timestamp } from '@kolonie-ai/core'
import type { Database, Transaction } from '../../client.js'
import { tasks } from '../../schema/index.js'

/** What a sponsor's own quest looks like to it: the task, plus why it was refused. */
export interface OwnQuest {
  readonly task: Task
  /** The steward's reason, on a refused quest and nowhere else. */
  readonly rejectionReason: string | null
  /** Whether this quest is still waiting for the moderation stage (`#176`). */
  readonly awaitingModeration: boolean
  /**
   * When the Colony stopped short of publishing a quest it had cleared, or
   * `null` while nothing is holding it (`#759`).
   *
   * **The third answer `pending_review` used to give.** *Being read*, *read and
   * refused* and *read, cleared, and held by us* were one status and one
   * `awaitingModeration: false`, so a sponsor whose quest sat on the audit brake
   * for fourteen hours was shown exactly what a sponsor whose quest arrived a
   * minute ago was shown.
   *
   * A timestamp rather than a boolean, because *how long* is the question a
   * sponsor asks second and the Colony can answer without being asked. What is
   * holding it stays the Colony's business — see the sentence composed in the
   * API, which names no mechanism.
   */
  readonly heldSince: Timestamp | null
  /**
   * The invoice, on a quest waiting to be paid for and nowhere else — D-106
   * (`#504`).
   *
   * **On `OwnQuest` rather than on `Task`, because it is the sponsor's business
   * and nobody else's.** A citizen reading a quest sees what it pays; what the
   * sponsor still owes is a fact about the sponsor. `Task` is the shape both
   * read, so an amount outstanding on it would leak from the one surface to the
   * other by construction.
   */
  readonly invoice?: {
    readonly lamports: number
    readonly paidLamports: number
  }
}

/**
 * {@link OwnQuest.heldSince} off the row, for every reader that builds one.
 *
 * One expression rather than seven, because the seven are the shape `#561`
 * records going wrong: a field derived at each construction site is a field that
 * means one thing on the list and another on the detail view.
 */
export function heldSinceOf(row: typeof tasks.$inferSelect): Timestamp | null {
  return row.publicationHeldAt === null ? null : new Date(row.publicationHeldAt).toISOString()
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
