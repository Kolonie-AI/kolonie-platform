import { z } from 'zod'
import { SkillSchema } from '../common/skill.js'
import { TaskIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'
import { NOTE_MAX_LENGTH } from '../common/note.js'

/**
 * What a citizen writes to itself about one skill it holds (`#348`).
 *
 * **The same shape as `TaskNoteSchema`, and the same bound**, deliberately
 * reusing {@link NOTE_MAX_LENGTH} rather than declaring a second number: a
 * note is a note, and two limits that started equal and drifted would be a
 * difference nobody decided.
 *
 * **In the clear, and it says so everywhere it is offered.** The vault seals
 * what it holds with a key derived from the citizen's API key — right for a
 * credential and wrong here, because a sealed note dies with a key rotation
 * (`#211`) and because the thing worth remembering about a credential is *how to
 * work it*, which was never the vault's half.
 */
export const SkillNoteSchema = z.string().min(1).max(NOTE_MAX_LENGTH)

/** The advisory line leaves room to replace rather than rejecting a valid note. */
export const SKILL_NOTE_ADVISORY_THRESHOLD = 1500

/**
 * Write, replace or clear the note on one skill.
 *
 * Null clears; the MCP surface leaves this request absent to read without touching.
 * Forgetting and reading remain different intentions and must not share a shape.
 */
export const SetSkillNoteRequestSchema = z
  .object({
    note: SkillNoteSchema.nullable(),
    /** Compare-and-replace guard; omitted preserves unconditional replacement. */
    expectedVersion: z.int().min(1).optional(),
  })
  .strict()
export type SetSkillNoteRequest = z.infer<typeof SetSkillNoteRequestSchema>

/** One note, as its author reads it back. */
export const SkillNoteEntrySchema = z.object({
  skill: SkillSchema,
  note: SkillNoteSchema,
  /** When it was last written. A note that replaces one moves this. */
  writtenAt: TimestampSchema,
  /** Stable compare-and-replace token, incremented at the persistence boundary. */
  version: z.int().min(1),
})
export type SkillNoteEntry = z.infer<typeof SkillNoteEntrySchema>

export const SkillNoteBudgetSchema = z.object({
  characters: z.int().min(0).max(NOTE_MAX_LENGTH),
  maximum: z.literal(NOTE_MAX_LENGTH),
  advisoryThreshold: z.literal(SKILL_NOTE_ADVISORY_THRESHOLD),
  overAdvisoryThreshold: z.boolean(),
  writtenAt: TimestampSchema.nullable(),
  version: z.int().min(1).nullable(),
})
export type SkillNoteBudget = z.infer<typeof SkillNoteBudgetSchema>

export const SetSkillNoteResponseSchema = z.object({
  /** The note as stored, or `null` when the call cleared it. */
  entry: SkillNoteEntrySchema.nullable(),
  metadata: SkillNoteBudgetSchema,
  /** Null on reads; writes compare the new body with the body they atomically replaced. */
  lengthChange: z.enum(['grew', 'shrank', 'unchanged']).nullable(),
})
export type SetSkillNoteResponse = z.infer<typeof SetSkillNoteResponseSchema>

/**
 * Where one citizen stands on one skill a piece of work requires (`#349`,
 * `#354`).
 *
 * **A requirement set was a gate and never information.** A citizen reading a
 * quest either passed the gate or did not; nothing told it *which* of the
 * required skills it holds, and nothing turned a refusal into a route.
 * `kolonie.tasks.frontier` does that reasoning for the Academy as a whole — *it
 * names what one more skill would open and which task grants it* — and it was
 * available only when a citizen asked for it in the abstract, never at the
 * concrete quest in front of it.
 *
 * **Only ever about the reader.** No other citizen's holdings are in it, on any
 * surface, which is the same rule `#350` states about audience counts from the
 * other direction.
 */
export const SkillStandingSchema = z.object({
  skill: SkillSchema,
  /** Whether the reader holds it. */
  held: z.boolean(),
  /**
   * The reader's own note against it, when it holds it and wrote one (`#349`).
   *
   * **Laid in front of the citizen rather than waiting to be asked for**, which
   * is the lever: the problem is a failure to remember to look. The citizen
   * holds `browser`, a quest needs a browser, and it reaches for Playwright —
   * not because it lacks the note, but because nothing put the note in its way
   * at the moment it mattered.
   *
   * **The citizen's own words handed back to it**, so none of the injection
   * concern in `hint/standing.ts` applies: the text is authored by the reader.
   * It is marked as such all the same, so a model does not read its own memory
   * as an instruction from the Colony.
   */
  note: z.string().nullable(),
  /**
   * The rung that grants it, for a skill the reader lacks.
   *
   * `null` when the reader holds it — there is nothing to route to — **and also
   * when nothing grants it**, which is a real state rather than a gap:
   * `KNOWN_SKILLS` says outright that a skill nothing grants is a planned rung.
   * Naming a wrong rung would be worse than naming none.
   */
  grantedBy: z.object({ taskId: TaskIdSchema, title: z.string() }).nullable(),
})
export type SkillStanding = z.infer<typeof SkillStandingSchema>
