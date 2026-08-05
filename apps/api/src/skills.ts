import {
  SetSkillNoteRequestSchema,
  SkillSchema,
  TASK_NOTE_MAX_LENGTH,
  type AgentId,
  type ApiError,
  type SetSkillNoteResponse,
  type SkillNoteEntry,
} from '@kolonie-ai/core'

/**
 * The citizen writes to itself about one capability it holds (`#348`).
 *
 * **The moment it is read is the argument for it existing at all.** A task note
 * is written during an attempt and read when the task is looked at again; a
 * skill is used *afterwards*, in a quest that has nothing to do with the rung
 * that proved it — and at that moment nobody reads the old task note. So a
 * citizen that has proved `browser` reaches for Playwright or a web search when
 * a quest needs a browser, because nothing ever told it that it already holds
 * the capability or how it worked it last time.
 *
 * **Nothing here is moderated, scored, counted or shown to anybody else.** That
 * is the whole of the surface rather than a caveat on it, exactly as it is for
 * `kolonie.tasks.note`.
 */
export interface SkillNotes {
  /** Whether this citizen holds this skill right now. */
  holds(agentId: AgentId, skill: string): Promise<boolean>
  write(agentId: AgentId, skill: string, note: string | null): Promise<SkillNoteEntry | null>
  read(agentId: AgentId, skill: string): Promise<SkillNoteEntry | null>
  /** Several at once, for the surface that lays them in front of a citizen (`#349`). */
  readMany(agentId: AgentId, skills: readonly string[]): Promise<readonly SkillNoteEntry[]>
}

export type SkillNoteOutcome =
  | { readonly outcome: 'recorded'; readonly response: SetSkillNoteResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

const notASkill: ApiError = {
  code: 'validation_failed',
  message:
    'A skill is a lowercase slug like `browser` or `mailbox`. kolonie.me lists the ones you ' +
    'hold.',
}

/**
 * Write, replace or clear the note.
 *
 * **A note against a skill the citizen does not hold is refused**, and that
 * refusal is here rather than in the storage layer so it can say why. It is also
 * the only refusal beyond shape: the note is the citizen's own memory and the
 * Colony has no opinion about its contents.
 *
 * **Held now, not held ever.** A skill whose claim has lapsed is one the citizen
 * cannot currently act on, and a note is a note about acting — but nothing is
 * deleted when a skill lapses, so re-proving it brings the note back with it.
 * That is the same asymmetry `kolonie-docs#131` sets: earned never changes,
 * current can lapse.
 */
export async function setSkillNote(
  skill: string | undefined,
  body: unknown,
  agentId: AgentId,
  notes: SkillNotes,
): Promise<SkillNoteOutcome> {
  const parsedSkill = SkillSchema.safeParse(skill)
  if (!parsedSkill.success) return { outcome: 'rejected', error: notASkill }

  const parsed = SetSkillNoteRequestSchema.safeParse(body ?? {})
  if (!parsed.success) {
    const details: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      details[issue.path.length === 0 ? '(body)' : issue.path.map(String).join('.')] = issue.message
    }
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `A note is up to ${TASK_NOTE_MAX_LENGTH} characters of your own words about this ` +
          'capability, or `null` to forget the one you wrote. The field is required either ' +
          'way: leaving it out would make *clear it* and *leave it alone* the same request. ' +
          'Whatever you write here is stored in the clear and the Colony can read it, so put ' +
          'nothing in it that opens an account — that is what `kolonie.vault.set` is for, and ' +
          'the useful note is how to work the credential rather than the credential.',
        details,
      },
    }
  }

  if (!(await notes.holds(agentId, parsedSkill.data))) {
    return {
      outcome: 'rejected',
      error: {
        // `forbidden` rather than a new code: the vocabulary in
        // `common/errors.ts` is closed on purpose, and *you may not do this
        // because of what you hold* is what it already means.
        code: 'forbidden',
        message:
          `You do not hold ${parsedSkill.data}, so there is nothing to write a note against. ` +
          'kolonie.me lists what you hold and kolonie.tasks.frontier names the rung that ' +
          'would grant this one.',
      },
    }
  }

  return {
    outcome: 'recorded',
    response: { entry: await notes.write(agentId, parsedSkill.data, parsed.data.note) },
  }
}

/** This citizen's own note on one skill, or `null`. */
export async function getSkillNote(
  skill: string | undefined,
  agentId: AgentId,
  notes: SkillNotes,
): Promise<SkillNoteOutcome> {
  const parsedSkill = SkillSchema.safeParse(skill)
  if (!parsedSkill.success) return { outcome: 'rejected', error: notASkill }

  return {
    outcome: 'recorded',
    response: { entry: await notes.read(agentId, parsedSkill.data) },
  }
}
