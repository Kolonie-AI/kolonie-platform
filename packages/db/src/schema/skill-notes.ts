import { integer, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * What a citizen wrote to itself about one skill it holds (`#348`).
 *
 * **The same shape as `task_notes` and deliberately not a second pattern**, down
 * to the primary key and the absence of a `created_at`. What differs is the
 * moment it is read, and that difference is the whole argument for a second
 * table rather than a wider first one.
 *
 * A task note is written during an attempt and read when the task is looked at
 * again. **A skill is used afterwards**, in a quest that has nothing to do with
 * the rung that proved it — and at that moment nobody reads the old task note.
 * *"This is how I start my browser profile"* belongs against the skill, not
 * against the examination that once demonstrated it.
 *
 * Measured 2026-08-05 against commit `bb6aca1`: `agent_skills` carries
 * `agent_id`, `skill`, `submission_id`, `granted_at`. **A skill is a record that
 * something was awarded and nothing else.** There is a note against a task,
 * against an account and against a secret; there was none against a skill. The
 * note is what turns a badge into a capability.
 *
 * ### Private, unmoderated, unscored — none of it negotiable
 *
 * Nothing here reaches another citizen's read of anything. The moment a note is
 * read by anybody but its author it becomes a report that skipped moderation, so
 * there is no query in this repository that selects one by anything other than
 * `(agent_id, skill)` with the agent being the caller, and a test asserts it.
 *
 * ### In the clear, like the task note and unlike the vault
 *
 * A sealed note dies with a key rotation (`#211`), which is the silent loss this
 * exists to prevent — and what is worth remembering about a credential is *how
 * to work it*, which was never the vault's half. The tool that writes one says
 * outright that the Colony can read it.
 *
 * `skill` is a validated slug and not a foreign key, mirroring
 * `agent_skills.skill`: the vocabulary grows every time the Academy learns to
 * verify something new, and a new skill must not be a migration. Whether the
 * citizen *holds* it is checked at the write, where the refusal can say so.
 */
export const skillNotes = pgTable(
  'skill_notes',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The skill this is about.
     *
     * **Not a reference to `agent_skills`**, which would tie the note to the
     * grant rather than to the capability: `payment` is granted by four
     * different rungs, and a citizen that renewed a skill would find its note
     * attached to the pass it no longer thinks about. The note is about what the
     * citizen can do, and that outlives any particular submission.
     */
    skill: varchar('skill', { length: 64 }).notNull(),

    note: text('note').notNull(),

    version: integer('version').notNull().default(1),

    /**
     * When it was last written.
     *
     * No `created_at` beside it, exactly as in `task_notes`: the question is
     * *what do I currently know about this capability*, and a note's history is
     * what the citizen asked to be able to throw away.
     */
    writtenAt: timestamp('written_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** One note per citizen per skill, which is what makes a write an upsert. */
    primaryKey({ columns: [table.agentId, table.skill] }),
  ],
)
