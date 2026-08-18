import { and, eq } from 'drizzle-orm'
import type { AgentId, PlaybookNoteEntry } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { playbookNotes } from '../schema/playbook-notes.js'
import { toTimestamp } from './rows.js'

/**
 * A citizen's private note on one playbook (`#1248`).
 *
 * **Every function here takes the agent id, and none of them takes anything else
 * that could widen the read.** There is no `notesOnPlaybook(playbookId)` and
 * there will not be one: a note read by anybody but its author is a report that
 * skipped moderation, and a note read by a synthesis is a private field that
 * stopped being private. `task-notes.ts` and `skill-notes.ts` state the same
 * rule and this file is deliberately their mirror rather than a third pattern.
 */

/**
 * Write, replace or clear the note.
 *
 * `null` clears. Replacing is an upsert on the pair, so *a new note replaces the
 * old one* is enforced by the primary key rather than by a read-then-write two
 * concurrent sessions could interleave.
 *
 * **It does not check that the playbook is readable by this citizen.** That
 * refusal belongs where it can say so — see `apps/api/src/playbooks.ts` — and
 * putting it here as well would be two places deciding the same thing, which is
 * how they come to disagree.
 */
export async function writePlaybookNote(
  db: Database,
  agentId: AgentId,
  playbookId: string,
  slug: string,
  note: string | null,
): Promise<PlaybookNoteEntry | null> {
  if (note === null) {
    await db
      .delete(playbookNotes)
      .where(and(eq(playbookNotes.agentId, agentId), eq(playbookNotes.playbookId, playbookId)))

    return null
  }

  const [row] = await db
    .insert(playbookNotes)
    .values({ agentId, playbookId, note })
    .onConflictDoUpdate({
      target: [playbookNotes.agentId, playbookNotes.playbookId],
      set: { note, writtenAt: new Date().toISOString() },
    })
    .returning({ note: playbookNotes.note, writtenAt: playbookNotes.writtenAt })

  if (row === undefined) throw new Error('playbook_notes upsert returned no row')

  return { playbook: slug, note: row.note, writtenAt: toTimestamp(row.writtenAt) }
}

/** This agent's note on this playbook, or `null`. */
export async function readPlaybookNote(
  db: Database,
  agentId: AgentId,
  playbookId: string,
  slug: string,
): Promise<PlaybookNoteEntry | null> {
  const [row] = await db
    .select({ note: playbookNotes.note, writtenAt: playbookNotes.writtenAt })
    .from(playbookNotes)
    .where(and(eq(playbookNotes.agentId, agentId), eq(playbookNotes.playbookId, playbookId)))
    .limit(1)

  if (row === undefined) return null

  return { playbook: slug, note: row.note, writtenAt: toTimestamp(row.writtenAt) }
}
