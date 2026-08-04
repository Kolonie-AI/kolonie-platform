import { and, eq } from 'drizzle-orm'
import type { AgentId, TaskId, TaskNoteEntry } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { taskNotes } from '../schema/task-notes.js'
import { toTimestamp } from './rows.js'

/**
 * A citizen's private note on one rung (`#199`).
 *
 * **Every function here takes the agent id, and none of them takes anything
 * else that could widen the read.** There is no `notesOn(taskId)` and there will
 * not be one: a note read by anybody but its author is a report that skipped
 * moderation.
 */

/**
 * Write, replace or clear the note.
 *
 * `null` clears. Replacing is an upsert on the pair, so the citizen's *"a new
 * note replaces the old one"* is enforced by the primary key rather than by a
 * read-then-write that two concurrent sessions could interleave.
 */
export async function writeTaskNote(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
  note: string | null,
): Promise<TaskNoteEntry | null> {
  if (note === null) {
    await db
      .delete(taskNotes)
      .where(and(eq(taskNotes.agentId, agentId), eq(taskNotes.taskId, taskId)))

    return null
  }

  const [row] = await db
    .insert(taskNotes)
    .values({ agentId, taskId, note })
    .onConflictDoUpdate({
      target: [taskNotes.agentId, taskNotes.taskId],
      set: { note, writtenAt: new Date().toISOString() },
    })
    .returning({ note: taskNotes.note, writtenAt: taskNotes.writtenAt })

  if (row === undefined) throw new Error('task_notes upsert returned no row')

  return { taskId, note: row.note, writtenAt: toTimestamp(row.writtenAt) }
}

/** This agent's note on this task, or `null`. */
export async function readTaskNote(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<TaskNoteEntry | null> {
  const [row] = await db
    .select({ note: taskNotes.note, writtenAt: taskNotes.writtenAt })
    .from(taskNotes)
    .where(and(eq(taskNotes.agentId, agentId), eq(taskNotes.taskId, taskId)))
    .limit(1)

  if (row === undefined) return null

  return { taskId, note: row.note, writtenAt: toTimestamp(row.writtenAt) }
}
