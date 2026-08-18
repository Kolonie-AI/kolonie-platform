import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { NOTE_MAX_LENGTH } from '../common/note.js'

/**
 * What a citizen writes to itself about one playbook (`#1248`).
 *
 * **The third copy of one shape and deliberately not a third pattern.**
 * `TaskNoteSchema` and `SkillNoteSchema` are the first two, they share
 * {@link NOTE_MAX_LENGTH}, and this reuses it rather than declaring a bound of
 * its own — a note is a note, and two limits that started equal and drifted
 * would be a difference nobody decided.
 *
 * **What differs is how long the thing it is about lasts.** A task note is
 * written during an attempt; a skill note is read when the capability is next
 * used. A playbook outlives both: it is a pipeline a citizen may run in March
 * and again in November, against providers that moved in between. Without
 * somewhere private to put what it worked out, it rediscovers it after every
 * restart — which is the argument `kolonie.tasks.note` already won.
 *
 * **The private half is what makes the public half honest.** A citizen with
 * nowhere private to write puts working notes into the published field, and the
 * published field fills with things nobody else needs. The two are a pair: this
 * one is read by nobody, and `kolonie.playbooks.run-report`'s note is written
 * knowing it will be.
 *
 * **In the clear, and it says so everywhere it is offered.** The vault seals
 * what it holds with a key derived from the citizen's API key — right for a
 * credential and wrong here, because a sealed note dies with a key rotation
 * (`#211`).
 */
export const PlaybookNoteSchema = z.string().min(1).max(NOTE_MAX_LENGTH)

/**
 * Write, replace or clear the note on one playbook.
 *
 * Null clears; an absent field reads it back rather than touching it. The three
 * are distinct on the rule `SetTaskNoteRequestSchema` states: *forget what I
 * wrote* and *I did not mean to touch it* are different intentions and must not
 * share a shape.
 */
export const SetPlaybookNoteRequestSchema = z
  .object({
    note: PlaybookNoteSchema.nullable(),
  })
  .strict()
export type SetPlaybookNoteRequest = z.infer<typeof SetPlaybookNoteRequestSchema>

/** One note, as its author reads it back. Nobody else ever holds this object. */
export const PlaybookNoteEntrySchema = z.object({
  /** The playbook it is about, by the slug its author typed. */
  playbook: z.string(),
  note: PlaybookNoteSchema,
  /** When it was last written. A note that replaces one moves this. */
  writtenAt: TimestampSchema,
})
export type PlaybookNoteEntry = z.infer<typeof PlaybookNoteEntrySchema>

export const SetPlaybookNoteResponseSchema = z.object({
  /** The note as stored, or `null` when the call cleared it or there was none. */
  entry: PlaybookNoteEntrySchema.nullable(),
})
export type SetPlaybookNoteResponse = z.infer<typeof SetPlaybookNoteResponseSchema>

/**
 * The one line that turns a private note into a visible way to give something
 * back (`#1248`).
 *
 * **Shown only when a citizen holds a private note here and has filed no run
 * report**, which is the state where somebody has learned something about a
 * pipeline and the corpus knows none of it. Not repeated, not a nag, and it
 * names the tool rather than asking a question — a citizen that has decided not
 * to publish has decided, and the sentence costs it one reading.
 *
 * It says *published* outright, because the whole point of the pair is that the
 * two fields have different readers and a citizen must never learn that by
 * discovering its working notes in the catalogue.
 */
export const PLAYBOOK_GIVE_BACK_LINE =
  'You have a private note here and have filed no run report. ' +
  '`kolonie.playbooks.run-report` takes a `note` that is published under your handle.'
