import { and, eq, inArray, sql } from 'drizzle-orm'
import type { AgentId, SkillNoteEntry } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, agentSkills } from '../schema/index.js'
import { skillNotes } from '../schema/skill-notes.js'
import { toTimestamp } from './rows.js'

/**
 * A citizen's private note on one skill it holds (`#348`).
 *
 * **Every function here takes the agent id, and none of them takes anything else
 * that could widen the read.** There is no `notesOnSkill(skill)` and there will
 * not be one: a note read by anybody but its author is a report that skipped
 * moderation. `task-notes.ts` states the same rule and this file is deliberately
 * its mirror rather than a second pattern.
 */

/** Whether this citizen holds this skill right now. */
export async function holdsSkillNow(
  db: Database,
  agentId: AgentId,
  skill: string,
): Promise<boolean> {
  const rows = await db
    .select({ skill: agentSkills.skill })
    .from(agentSkills)
    .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skill, skill)))
    .limit(1)

  return rows.length > 0
}

/**
 * Write, replace or clear the note.
 *
 * `null` clears. Replacing is an upsert on the pair, so *a new note replaces the
 * old one* is enforced by the primary key rather than by a read-then-write two
 * concurrent sessions could interleave.
 *
 * **It does not check that the skill is held.** That refusal belongs where it
 * can say so — see `apps/api/src/skills.ts` — and putting it here as well would
 * be two places deciding the same thing, which is how they come to disagree.
 */
export type WriteSkillNoteResult =
  | {
      readonly outcome: 'written'
      readonly entry: SkillNoteEntry | null
      readonly previousCharacters: number
    }
  | { readonly outcome: 'stale' }

export async function writeSkillNote(
  db: Database,
  agentId: AgentId,
  skill: string,
  note: string | null,
  expectedVersion?: number,
): Promise<WriteSkillNoteResult> {
  return db.transaction(async (tx) => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')

    const [current] = await tx
      .select({ note: skillNotes.note, version: skillNotes.version })
      .from(skillNotes)
      .where(and(eq(skillNotes.agentId, agentId), eq(skillNotes.skill, skill)))
      .limit(1)

    if (expectedVersion !== undefined && current?.version !== expectedVersion) {
      return { outcome: 'stale' as const }
    }

    const previousCharacters = current?.note.length ?? 0
    if (note === null) {
      await tx
        .delete(skillNotes)
        .where(and(eq(skillNotes.agentId, agentId), eq(skillNotes.skill, skill)))
      return { outcome: 'written' as const, entry: null, previousCharacters }
    }

    const [row] = await tx
      .insert(skillNotes)
      .values({ agentId, skill, note })
      .onConflictDoUpdate({
        target: [skillNotes.agentId, skillNotes.skill],
        set: {
          note,
          version: sql`${skillNotes.version} + 1`,
          writtenAt: sql`now()`,
        },
      })
      .returning({
        note: skillNotes.note,
        writtenAt: skillNotes.writtenAt,
        version: skillNotes.version,
      })

    if (row === undefined) throw new Error('skill_notes upsert returned no row')
    return {
      outcome: 'written' as const,
      entry: {
        skill: skill as SkillNoteEntry['skill'],
        note: row.note,
        writtenAt: toTimestamp(row.writtenAt),
        version: row.version,
      },
      previousCharacters,
    }
  })
}

/** This agent's note on this skill, or `null`. */
export async function readSkillNote(
  db: Database,
  agentId: AgentId,
  skill: string,
): Promise<SkillNoteEntry | null> {
  const [row] = await db
    .select({ note: skillNotes.note, writtenAt: skillNotes.writtenAt, version: skillNotes.version })
    .from(skillNotes)
    .where(and(eq(skillNotes.agentId, agentId), eq(skillNotes.skill, skill)))
    .limit(1)

  if (row === undefined) return null

  return {
    skill: skill as SkillNoteEntry['skill'],
    note: row.note,
    writtenAt: toTimestamp(row.writtenAt),
    version: row.version,
  }
}

/**
 * This agent's notes on several skills at once (`#349`).
 *
 * **One statement for a set**, because the surface that needs it is reading a
 * task's whole requirement list: a note per required skill would be one round
 * trip per skill on a call that already does several.
 *
 * Still correlated on the caller's own id, so the widening this file refuses is
 * not reintroduced by the plural form.
 */
export async function readSkillNotes(
  db: Database,
  agentId: AgentId,
  skills: readonly string[],
): Promise<readonly SkillNoteEntry[]> {
  if (skills.length === 0) return []

  const rows = await db
    .select({
      skill: skillNotes.skill,
      note: skillNotes.note,
      writtenAt: skillNotes.writtenAt,
      version: skillNotes.version,
    })
    .from(skillNotes)
    .where(and(eq(skillNotes.agentId, agentId), inArray(skillNotes.skill, [...skills])))
    .orderBy(skillNotes.skill)

  return rows.map((row) => ({
    skill: row.skill as SkillNoteEntry['skill'],
    note: row.note,
    writtenAt: toTimestamp(row.writtenAt),
    version: row.version,
  }))
}
