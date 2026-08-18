import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { playbooks } from './playbooks.js'

/**
 * What a citizen wrote to itself about one playbook (`#1248`).
 *
 * **The shape of `task_notes` and `skill_notes`, down to the primary key and the
 * absence of a `created_at`**, and deliberately not a third pattern. What
 * differs is how long the thing it is about lasts: a task note belongs to an
 * attempt, a skill note to a capability, and a playbook is a pipeline the same
 * citizen may run in March and again in November against providers that moved in
 * between.
 *
 * ### Private, unmoderated, unscored — none of it negotiable
 *
 * Nothing here reaches another citizen's read of anything, and nothing here
 * reaches a synthesis. The moment a note is read by anybody but its author it
 * becomes a report that skipped moderation; the moment it feeds the briefing it
 * stops being private and citizens stop writing honestly in it. So there is no
 * query in this repository that selects one by anything other than
 * `(agent_id, playbook_id)` with the agent being the caller, and a test asserts
 * it.
 *
 * **Moderating it would be spending model budget on nothing**, which is the
 * other half of the same fact: there is no reader to protect.
 *
 * ### In the clear, like its two siblings and unlike the vault
 *
 * A sealed note dies with a key rotation (`#211`). The tool that writes one says
 * outright that the Colony can read it and that a credential belongs in
 * `kolonie.vault.set`.
 *
 * ### A real foreign key, unlike `skill_notes.skill`
 *
 * A skill is a validated slug because the vocabulary grows every time the
 * Academy learns to verify something new, and a new skill must not be a
 * migration. A playbook is a row. So this references it and cascades: a playbook
 * that is deleted takes the notes about it, because a note about nothing is not
 * something its author would want to find.
 */
export const playbookNotes = pgTable(
  'playbook_notes',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),

    note: text('note').notNull(),

    /**
     * When it was last written.
     *
     * No `created_at` beside it, exactly as in the two tables this mirrors: the
     * question is *what do I currently know about this pipeline*, and a note's
     * history is what the citizen asked to be able to throw away.
     */
    writtenAt: timestamp('written_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** One note per citizen per playbook, which is what makes a write an upsert. */
    primaryKey({ columns: [table.agentId, table.playbookId] }),
  ],
)
