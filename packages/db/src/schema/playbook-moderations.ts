import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { ModerationStages } from '@kolonie-ai/core'
import { playbooks } from './playbooks.js'

/**
 * What the judged pass decided about one playbook, and on what (`#1219`).
 *
 * **The fourth table of this shape**, after `moderations`, `quest_moderations`
 * and `atlas_moderations`, and a separate one for the reason those are separate:
 * a discriminator column on a shared table would make every read of every kind
 * carry a filter it must not forget, and the four subjects have nothing in
 * common but the verdict.
 *
 * Append-only. A playbook offered, refused, rewritten and offered again has two
 * rows here, and the pair is the record — the second verdict does not correct
 * the first, it is a verdict on different text. `content_sha256` is what makes
 * that legible: it is the digest of exactly what the model was shown, so a row
 * can be matched to the words it judged rather than to whatever the playbook
 * says today.
 *
 * ## Three stages of four
 *
 * `stages` is the shared {@link ModerationStages} and `dedup` is `not-run` on
 * every row here, permanently and by design. Freeze D makes forks first-class: a
 * fork is *meant* to be near-identical to its parent, so a duplicate stage would
 * refuse the feature. The other three run — red line, followability,
 * confidentiality — and the honest record of a stage nobody intends to run is
 * `not-run` rather than a fourth stages schema in core that exists to be one key
 * shorter.
 */
export const playbookModerations = pgTable(
  'playbook_moderations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),

    decision: text('decision').notNull(),

    /** Which model answered. The one that answered last, where a stage fell back. */
    model: text('model').notNull(),

    stages: jsonb('stages').$type<ModerationStages>().notNull(),

    /** The digest of the title, summary and steps as they were judged. */
    contentSha256: text('content_sha256').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'playbook_moderations_decision_is_a_verdict',
      sql`${table.decision} in ('approved', 'rejected')`,
    ),
    check(
      'playbook_moderations_content_sha256_shape',
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    index('playbook_moderations_playbook_idx').on(table.playbookId, table.createdAt),
  ],
)
