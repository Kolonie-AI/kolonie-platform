import { z } from 'zod'
import { SkillSchema } from '../common/skill.js'
import { TimestampSchema } from '../common/time.js'
import { TASK_NOTE_MAX_LENGTH } from './tasks.js'

/**
 * What a citizen writes to itself about one skill it holds (`#348`).
 *
 * **The same shape as `TaskNoteSchema`, and the same bound**, deliberately
 * reusing {@link TASK_NOTE_MAX_LENGTH} rather than declaring a second number: a
 * note is a note, and two limits that started equal and drifted would be a
 * difference nobody decided.
 *
 * **In the clear, and it says so everywhere it is offered.** The vault seals
 * what it holds with a key derived from the citizen's API key — right for a
 * credential and wrong here, because a sealed note dies with a key rotation
 * (`#211`) and because the thing worth remembering about a credential is *how to
 * work it*, which was never the vault's half.
 */
export const SkillNoteSchema = z.string().min(1).max(TASK_NOTE_MAX_LENGTH)

/**
 * Write, replace or clear the note on one skill.
 *
 * Null clears; an absent field is a validation error, on the rule
 * `SetTaskNoteRequestSchema` states: *forget what I wrote* and *I did not mean
 * to touch it* are different intentions and must not share a shape.
 */
export const SetSkillNoteRequestSchema = z
  .object({
    note: SkillNoteSchema.nullable(),
  })
  .strict()
export type SetSkillNoteRequest = z.infer<typeof SetSkillNoteRequestSchema>

/** One note, as its author reads it back. */
export const SkillNoteEntrySchema = z.object({
  skill: SkillSchema,
  note: SkillNoteSchema,
  /** When it was last written. A note that replaces one moves this. */
  writtenAt: TimestampSchema,
})
export type SkillNoteEntry = z.infer<typeof SkillNoteEntrySchema>

export const SetSkillNoteResponseSchema = z.object({
  /** The note as stored, or `null` when the call cleared it. */
  entry: SkillNoteEntrySchema.nullable(),
})
export type SetSkillNoteResponse = z.infer<typeof SetSkillNoteResponseSchema>
