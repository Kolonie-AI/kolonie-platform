import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  OPERATE_NOTE_MAX_LENGTH,
  OPERATE_NOTE_TAGS,
  GUIDANCE_CONTENT_MIN_LENGTH,
} from '@kolonie-ai/core'
import { agents } from './agents.js'
import { accountEpisodes } from './account-threads.js'
import { moderationStatus } from './enums.js'

/**
 * Post-account operations tips for a `(kind, provider)` pair (`#1299`).
 *
 * ## Why its own table
 *
 * Walk notes (`#1035`) are about the way *in*. Cautions and runtime notes on
 * `provider_recipes` are curator vocabulary. This is citizen prose about what
 * happens *after* an account exists — and it must never land in `steps`, which
 * is the `#1032` line `episodeVerdict` already holds for maintenance episodes.
 *
 * ## Moderated like other citizen prose
 *
 * Raw {@link providerOperateNotes.body} is what the author wrote.
 * {@link providerOperateNotes.scrubbedBody} is what a reader gets, and only when
 * {@link providerOperateNotes.proseStatus} is `approved`. The read path selects
 * the scrubbed column, so *no citizen's unmoderated words reach a reader* holds
 * by there being nothing else to select — the same defence
 * `provider_reports_scrubbed_iff_approved` and walk notes use.
 *
 * ## One standing tip per citizen × pair × tag
 *
 * Rewriting replaces rather than stacks: a citizen that learned the IMAP tip was
 * wrong should correct it, not leave two contradictory sentences for the next
 * reader. Multiple citizens may each hold a tip on the same tag.
 */
export const providerOperateNotes = pgTable(
  'provider_operate_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Account kind and provider, free text for the reason they are on
     * `provider_recipes`: the vocabulary is what the Colony is learning, and a
     * new kind must not be a migration.
     */
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),

    /** Closed tag vocabulary — see `OperateNoteTagSchema`. */
    tag: text('tag').notNull(),

    /** The tip as its author wrote it. Never served to another citizen. */
    body: text('body').notNull(),

    /**
     * The tip after moderation, or null.
     *
     * Null covers pending, rejected, and the empty case alike — a reader treats
     * all three as *no tip here*.
     */
    scrubbedBody: text('scrubbed_body'),

    proseStatus: moderationStatus('prose_status').notNull().default('pending'),

    /**
     * The maintenance episode this tip came from, when it did.
     *
     * Nullable: an explicit tip report needs no episode, and an episode that is
     * later erased should not take the tip with it — the tip is about the
     * provider, not about the conversation.
     */
    episodeId: uuid('episode_id').references(() => accountEpisodes.id, {
      onDelete: 'set null',
    }),

    writtenAt: timestamp('written_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('provider_operate_notes_agent_pair_tag').on(
      table.agentId,
      table.kind,
      table.provider,
      table.tag,
    ),
    check(
      'provider_operate_notes_tag_is_known',
      sql`${table.tag} in (${sql.raw(OPERATE_NOTE_TAGS.map((one) => `'${one}'`).join(', '))})`,
    ),
    check(
      'provider_operate_notes_body_length',
      sql`char_length(btrim(${table.body})) between ${sql.raw(String(GUIDANCE_CONTENT_MIN_LENGTH))} and ${sql.raw(String(OPERATE_NOTE_MAX_LENGTH))}`,
    ),
    check(
      'provider_operate_notes_scrubbed_iff_approved',
      sql`${table.scrubbedBody} is null or ${table.proseStatus} = 'approved'`,
    ),
    check(
      'provider_operate_notes_scrubbed_length',
      sql`${table.scrubbedBody} is null
          or char_length(btrim(${table.scrubbedBody})) between ${sql.raw(String(GUIDANCE_CONTENT_MIN_LENGTH))} and ${sql.raw(String(OPERATE_NOTE_MAX_LENGTH))}`,
    ),
    index('provider_operate_notes_pair_idx').on(table.kind, table.provider),
    index('provider_operate_notes_pending_idx')
      .on(table.writtenAt)
      .where(sql`${table.proseStatus} = 'pending'`),
  ],
)
