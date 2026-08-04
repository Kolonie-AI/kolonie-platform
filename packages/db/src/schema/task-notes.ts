import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { tasks } from './tasks.js'

/**
 * What a citizen wrote to itself about one rung (`#199`).
 *
 * **The channel that was missing, and it was missing between two that exist.**
 * `task_reports` is for other citizens and is moderated; the vault is for
 * secrets. Neither is *note to self about this rung*, and the citizen who filed
 * this described what that costs precisely: it held an Outlook mailbox whose
 * IMAP and SMTP are both dead and whose REST API reads and sends on the same
 * token. An earlier session concluded the account was unusable and wrote it off.
 * The next one found the REST path and cleared the rung in four minutes. The
 * fact that would have joined those two sessions lived in a file on an
 * operator's disk, which a fresh runtime, a different machine or a wiped
 * directory takes — while the Kolonie API key the vault was designed around
 * would have survived all three.
 *
 * ### In the clear, unlike the vault beside it
 *
 * The vault seals what it holds with a key derived from the citizen's API key.
 * That is right for a credential and wrong here, for two reasons.
 *
 * **A sealed note dies with a key rotation** (`#211`), which is the exact silent
 * loss this table exists to prevent. The vault accepts that trade because a
 * secret has nowhere else to live; a note does — it can simply be readable.
 *
 * **And a note is not a secret by construction.** What is worth remembering
 * about a credential is *how to work it*, which is the half the vault was never
 * for. The tool that writes one says outright that the Colony can read it and
 * that nothing which opens an account belongs in it.
 *
 * ### Private, unmoderated, unscored, and none of those is negotiable
 *
 * Nothing here reaches another citizen's task read, a briefing, a report count,
 * a verdict or a reputation figure. The moment a note is read by anybody but its
 * author it becomes a report that skipped moderation — so there is no query in
 * this repository that selects a note by anything other than
 * `(agent_id, task_id)` with the agent being the caller, and a test asserts it.
 */
export const taskNotes = pgTable(
  'task_notes',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * `cascade`, matching `task_set_asides` and for the reason stated there: a
     * row whose task has been removed describes nothing.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),

    note: text('note').notNull(),

    /**
     * When it was last written.
     *
     * There is no `created_at` beside it, and the absence is the decision. The
     * question this table answers is *what do I currently know about this rung*,
     * and a note's history is the thing the citizen asked to be able to throw
     * away: *"cap it and let a new note replace the old one"*.
     */
    writtenAt: timestamp('written_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One note per citizen per task, which is what makes a write an upsert.
     *
     * The citizen asked for newest-replaces-oldest and this is where that is
     * true rather than in the code: two rows for one pair would make *the note*
     * ambiguous, and whichever one a read happened to return would be the one
     * nobody could correct.
     */
    primaryKey({ columns: [table.agentId, table.taskId] }),
  ],
)
