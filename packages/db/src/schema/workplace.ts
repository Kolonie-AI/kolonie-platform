import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  WORKPLACE_BOARD_KINDS,
  WORKPLACE_BODY_MAX_LENGTH,
  WORKPLACE_CADENCES,
  WORKPLACE_LANES,
  WORKPLACE_LINK_KINDS,
  WORKPLACE_LINK_REF_MAX_LENGTH,
  WORKPLACE_MEMBERSHIP_ROLES,
  WORKPLACE_SENTENCE_MAX_LENGTH,
  WORKPLACE_TITLE_MAX_LENGTH,
} from '@kolonie-ai/core'
import { agents } from './agents.js'
import { humans } from './humans.js'

/**
 * Private Workplace boards (`#1757`).
 *
 * **Not Academy `tasks`.** A list is `workplace_cards.status`. There is no
 * `workplace_lists` table and there must never be one: a seventh lane arriving
 * as a row is how `todo` sneaks back in after D-146 closed the matrix.
 *
 * Vocabularies come from `@kolonie-ai/core` the way `playbooks` already does.
 * The checks are built from those lists, so widening a lane is a migration.
 */
const oneOf = (values: readonly string[]) => sql.raw(values.map((one) => `'${one}'`).join(', '))

const TITLE_MAX = sql.raw(String(WORKPLACE_TITLE_MAX_LENGTH))
const BODY_MAX = sql.raw(String(WORKPLACE_BODY_MAX_LENGTH))
const SENTENCE_MAX = sql.raw(String(WORKPLACE_SENTENCE_MAX_LENGTH))
const LINK_REF_MAX = sql.raw(String(WORKPLACE_LINK_REF_MAX_LENGTH))

/**
 * One board. Exactly one citizen owns it (D-146): they created it, or it is
 * their default board. That citizen cannot be removed; archiving an additional
 * board is a timestamp, not a seventh lane.
 */
export const workplaceBoards = pgTable(
  'workplace_boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`: a board is that citizen's. Erasure takes owned boards and
     * everything hanging off them. Cards they owned on *somebody else's* board
     * are the other half — `workplace_cards.owner_id` is `set null`.
     */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    title: varchar('title', { length: WORKPLACE_TITLE_MAX_LENGTH }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('workplace_boards_owner_idx').on(table.ownerId, table.createdAt),
    check(
      'workplace_boards_kind_is_known',
      sql`${table.kind} in (${oneOf(WORKPLACE_BOARD_KINDS)})`,
    ),
    check('workplace_boards_version_is_positive', sql`${table.version} >= 1`),
    check(
      'workplace_boards_title_is_bounded',
      sql`char_length(${table.title}) between 1 and ${TITLE_MAX}`,
    ),
    /**
     * One live default board per citizen. Partial on `archived_at is null` so a
     * future decision that default boards may be archived does not have to
     * rewrite history; storage refuses that archive today.
     */
    uniqueIndex('workplace_boards_one_live_default')
      .on(table.ownerId)
      .where(sql`${table.kind} = 'default' and ${table.archivedAt} is null`),
  ],
)

/**
 * Who may see and mutate a board.
 *
 * **PK `(board_id, citizen_id)`** — one seat, so adding a member twice is
 * idempotent at the index rather than a second row. The board owner must have
 * an `owner` row; storage writes both in the same transaction because a check
 * across two tables is a trigger, and a trigger here would restate a write
 * that already has to be atomic.
 */
export const workplaceBoardMemberships = pgTable(
  'workplace_board_memberships',
  {
    boardId: uuid('board_id')
      .notNull()
      .references(() => workplaceBoards.id, { onDelete: 'cascade' }),

    citizenId: uuid('citizen_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    role: varchar('role', { length: 16 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.boardId, table.citizenId] }),
    index('workplace_board_memberships_citizen_idx').on(table.citizenId),
    check(
      'workplace_board_memberships_role_is_known',
      sql`${table.role} in (${oneOf(WORKPLACE_MEMBERSHIP_ROLES)})`,
    ),
  ],
)

/**
 * Board-scoped labels. Unique `(board_id, slug)` so the provisioner's default
 * set (`#1758`) can plant `profession` once and a citizen cannot double it.
 */
export const workplaceLabels = pgTable(
  'workplace_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => workplaceBoards.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 32 }).notNull(),
    name: varchar('name', { length: 32 }).notNull(),
    colour: varchar('colour', { length: 7 }).notNull(),
  },
  (table) => [
    uniqueIndex('workplace_labels_board_slug').on(table.boardId, table.slug),
    /**
     * Pair the id with the board so `workplace_card_labels` can demand the
     * label and the card share a board, as two composite foreign keys rather
     * than as a promise in storage.
     */
    unique('workplace_labels_id_board').on(table.id, table.boardId),
    check(
      'workplace_labels_slug_is_a_slug',
      sql`${table.slug} ~ '^[a-z][a-z0-9-]*$' and char_length(${table.slug}) between 1 and 32`,
    ),
    check('workplace_labels_name_is_bounded', sql`char_length(${table.name}) between 1 and 32`),
  ],
)

/**
 * A card on a board.
 *
 * **No `assignees[]`.** One `owner_id`, or none. Position is a sparse numeric
 * rank unique per live `(board_id, status)` — uniqueness is this index, not a
 * compact-renumber in the request transaction.
 *
 * `owner_id` is `set null` so a card on a foreign board survives its owner
 * leaving. Storage rewrites `in_progress|blocked|review` to `ready` in the
 * same erasure transaction first; the check below would otherwise refuse the
 * null.
 */
export const workplaceCards = pgTable(
  'workplace_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => workplaceBoards.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).notNull(),
    title: varchar('title', { length: WORKPLACE_TITLE_MAX_LENGTH }).notNull(),
    description: text('description'),
    ownerId: uuid('owner_id').references(() => agents.id, { onDelete: 'set null' }),
    /**
     * Sparse rank, not an array index. `doublePrecision` so a reorder writes
     * the new ranks only — inserting between 1000 and 2000 is 1500, and
     * nothing else in the lane moves.
     */
    position: doublePrecision('position').notNull(),
    priority: varchar('priority', { length: 32 }).notNull().default('unset'),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'string' }),
    blockedBy: text('blocked_by'),
    unblockWhen: text('unblock_when'),
    outcome: text('outcome'),
    version: integer('version').notNull().default(1),
    coverColour: varchar('cover_colour', { length: 7 }),
    seedKey: varchar('seed_key', { length: 64 }),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('workplace_cards_id_board').on(table.id, table.boardId),
    uniqueIndex('workplace_cards_rank_in_lane')
      .on(table.boardId, table.status, table.position)
      .where(sql`${table.archivedAt} is null`),
    uniqueIndex('workplace_cards_seed_key')
      .on(table.boardId, table.seedKey)
      .where(sql`${table.seedKey} is not null`),
    index('workplace_cards_board_lane_idx').on(table.boardId, table.status, table.position),
    index('workplace_cards_owner_idx').on(table.ownerId),
    check('workplace_cards_status_is_known', sql`${table.status} in (${oneOf(WORKPLACE_LANES)})`),
    check('workplace_cards_version_is_positive', sql`${table.version} >= 1`),
    check(
      'workplace_cards_title_is_bounded',
      sql`char_length(${table.title}) between 1 and ${TITLE_MAX}`,
    ),
    check(
      'workplace_cards_description_is_bounded',
      sql`${table.description} is null or char_length(${table.description}) <= ${BODY_MAX}`,
    ),
    check('workplace_cards_priority_is_a_token', sql`${table.priority} ~ '^[a-z][a-z0-9_-]*$'`),
    /**
     * Inbox, Ready and Done may be ownerless. Live work may not (D-146).
     * Done is ownerless after the accountable citizen is erased; the
     * outcome stays. One check rather than four, so a new live lane
     * cannot be added to the status list without failing this.
     */
    check(
      'workplace_cards_active_has_owner',
      sql`${table.status} in ('inbox', 'ready', 'done') or ${table.ownerId} is not null`,
    ),
    check(
      'workplace_cards_blocked_is_explained',
      sql`${table.status} <> 'blocked'
        or (${table.blockedBy} is not null and ${table.unblockWhen} is not null)`,
    ),
    check(
      'workplace_cards_done_has_outcome',
      sql`${table.status} <> 'done' or ${table.outcome} is not null`,
    ),
    check(
      'workplace_cards_blocked_by_is_bounded',
      sql`${table.blockedBy} is null or char_length(${table.blockedBy}) between 1 and ${SENTENCE_MAX}`,
    ),
    check(
      'workplace_cards_unblock_when_is_bounded',
      sql`${table.unblockWhen} is null or char_length(${table.unblockWhen}) between 1 and ${SENTENCE_MAX}`,
    ),
    check(
      'workplace_cards_outcome_is_bounded',
      sql`${table.outcome} is null or char_length(${table.outcome}) between 1 and ${SENTENCE_MAX}`,
    ),
  ],
)

/**
 * Card ↔ label. The two composite foreign keys are the cross-board refusal:
 * a label from board A cannot sit on a card from board B because both keys
 * demand the same `board_id`.
 */
export const workplaceCardLabels = pgTable(
  'workplace_card_labels',
  {
    cardId: uuid('card_id').notNull(),
    labelId: uuid('label_id').notNull(),
    boardId: uuid('board_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.cardId, table.labelId] }),
    foreignKey({
      name: 'workplace_card_labels_card_board_fk',
      columns: [table.cardId, table.boardId],
      foreignColumns: [workplaceCards.id, workplaceCards.boardId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workplace_card_labels_label_board_fk',
      columns: [table.labelId, table.boardId],
      foreignColumns: [workplaceLabels.id, workplaceLabels.boardId],
    }).onDelete('cascade'),
  ],
)

export const workplaceChecklists = pgTable(
  'workplace_checklists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => workplaceCards.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: WORKPLACE_TITLE_MAX_LENGTH }).notNull(),
    position: integer('position').notNull().default(0),
  },
  (table) => [
    index('workplace_checklists_card_idx').on(table.cardId, table.position),
    check(
      'workplace_checklists_title_is_bounded',
      sql`char_length(${table.title}) between 1 and ${TITLE_MAX}`,
    ),
    check('workplace_checklists_position_is_non_negative', sql`${table.position} >= 0`),
  ],
)

export const workplaceChecklistItems = pgTable(
  'workplace_checklist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checklistId: uuid('checklist_id')
      .notNull()
      .references(() => workplaceChecklists.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: WORKPLACE_TITLE_MAX_LENGTH }).notNull(),
    /** Timestamp, not a boolean — `doneAt` in core. Null means not done. */
    doneAt: timestamp('done_at', { withTimezone: true, mode: 'string' }),
    position: integer('position').notNull().default(0),
  },
  (table) => [
    index('workplace_checklist_items_checklist_idx').on(table.checklistId, table.position),
    check(
      'workplace_checklist_items_title_is_bounded',
      sql`char_length(${table.title}) between 1 and ${TITLE_MAX}`,
    ),
    check('workplace_checklist_items_position_is_non_negative', sql`${table.position} >= 0`),
  ],
)

export const workplaceComments = pgTable(
  'workplace_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => workplaceCards.id, { onDelete: 'cascade' }),
    /**
     * `cascade`: a comment is writing. Surfaces that return `body` carry
     * `WORKPLACE_UNTRUSTED_CONTENT`.
     */
    authorId: uuid('author_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('workplace_comments_card_idx').on(table.cardId, table.createdAt),
    check(
      'workplace_comments_body_is_bounded',
      sql`char_length(${table.body}) between 1 and ${BODY_MAX}`,
    ),
  ],
)

/**
 * A typed pointer on a card (`#1765`).
 *
 * **No foreign keys onto the target.** An account, a vault name, a task, a
 * playbook or a URL may go away; the pointer stays. Linking does not grant
 * access. Vault stores the entry **name** in `ref`, never the value.
 *
 * Unique on `(card_id, kind, ref)` so POST is idempotent. Cascade from the
 * card; no `agent_id` — erasure of a citizen takes the link only when it
 * takes the card.
 */
export const workplaceCardLinks = pgTable(
  'workplace_card_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => workplaceCards.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull(),
    ref: text('ref').notNull(),
    note: varchar('note', { length: WORKPLACE_SENTENCE_MAX_LENGTH }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('workplace_card_links_card_kind_ref').on(table.cardId, table.kind, table.ref),
    index('workplace_card_links_card_idx').on(table.cardId, table.createdAt),
    check(
      'workplace_card_links_kind_is_known',
      sql`${table.kind} in (${oneOf(WORKPLACE_LINK_KINDS)})`,
    ),
    check(
      'workplace_card_links_ref_is_bounded',
      sql`char_length(${table.ref}) between 1 and ${LINK_REF_MAX}`,
    ),
    check(
      'workplace_card_links_note_is_bounded',
      sql`${table.note} is null or char_length(${table.note}) between 1 and ${SENTENCE_MAX}`,
    ),
  ],
)

/**
 * A structured handover, not a reason string (D-146). Partial unique on
 * `is_current` so a card has at most one live handover; history stays.
 */
export const workplaceHandovers = pgTable(
  'workplace_handovers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => workplaceCards.id, { onDelete: 'cascade' }),
    fromId: uuid('from_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    toId: uuid('to_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    done: text('done').notNull(),
    learned: text('learned').notNull(),
    next: text('next').notNull(),
    blocked: text('blocked'),
    evidenceLinks: text('evidence_links')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isCurrent: boolean('is_current').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('workplace_handovers_card_idx').on(table.cardId, table.createdAt),
    uniqueIndex('workplace_handovers_one_current')
      .on(table.cardId)
      .where(sql`${table.isCurrent}`),
    check(
      'workplace_handovers_done_is_bounded',
      sql`char_length(${table.done}) between 1 and ${BODY_MAX}`,
    ),
    check(
      'workplace_handovers_learned_is_bounded',
      sql`char_length(${table.learned}) between 1 and ${BODY_MAX}`,
    ),
    check(
      'workplace_handovers_next_is_bounded',
      sql`char_length(${table.next}) between 1 and ${BODY_MAX}`,
    ),
    check(
      'workplace_handovers_blocked_is_bounded',
      sql`${table.blocked} is null or char_length(${table.blocked}) between 1 and ${BODY_MAX}`,
    ),
    check(
      'workplace_handovers_evidence_within_bounds',
      sql`cardinality(${table.evidenceLinks}) <= 20`,
    ),
  ],
)

export const workplaceRecurrenceRules = pgTable(
  'workplace_recurrence_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => workplaceBoards.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => workplaceCards.id, { onDelete: 'cascade' }),
    cadence: varchar('cadence', { length: 16 }).notNull(),
    nextDueAt: timestamp('next_due_at', { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('workplace_recurrence_rules_due_idx').on(table.nextDueAt),
    uniqueIndex('workplace_recurrence_rules_card').on(table.cardId),
    check(
      'workplace_recurrence_rules_cadence_is_known',
      sql`${table.cadence} in (${oneOf(WORKPLACE_CADENCES)})`,
    ),
  ],
)

/**
 * Idempotent ticks (`#1762` materialises them). `card_id` is null until a
 * card exists for that period; unique `(rule_id, period_start)` is what
 * makes a second tick a no-op rather than a second card.
 */
export const workplaceRecurrenceOccurrences = pgTable(
  'workplace_recurrence_occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => workplaceRecurrenceRules.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'string' }).notNull(),
    cardId: uuid('card_id').references(() => workplaceCards.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('workplace_recurrence_occurrences_tick').on(table.ruleId, table.periodStart),
  ],
)

/**
 * Append-only events. A linked human may be named; their erasure nulls
 * `actor_human_id` and leaves the card with the agent.
 */
export const workplaceActivity = pgTable(
  'workplace_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => workplaceBoards.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id').references(() => workplaceCards.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    actorHumanId: uuid('actor_human_id').references(() => humans.id, { onDelete: 'set null' }),
    verb: varchar('verb', { length: 64 }).notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('workplace_activity_board_idx').on(table.boardId, table.createdAt),
    index('workplace_activity_card_idx').on(table.cardId, table.createdAt),
  ],
)

/**
 * Replay of mutating POSTs. Unique `(actor_kind, actor_id, key)` so a retry
 * returns the stored body and never a second side effect. `actor_id` is not a
 * foreign key: the actor is a citizen or a human, and a mixed column cannot
 * point at both parents. TTL is `expires_at`; a sweep drops stale rows.
 */
export const workplaceIdempotency = pgTable(
  'workplace_idempotency',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorKind: varchar('actor_kind', { length: 16 }).notNull(),
    actorId: uuid('actor_id').notNull(),
    key: varchar('key', { length: 128 }).notNull(),
    status: integer('status').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('workplace_idempotency_actor_key').on(table.actorKind, table.actorId, table.key),
    index('workplace_idempotency_expiry_idx').on(table.expiresAt),
    check(
      'workplace_idempotency_actor_kind_is_known',
      sql`${table.actorKind} in ('citizen', 'human')`,
    ),
    check('workplace_idempotency_key_is_bounded', sql`char_length(${table.key}) between 1 and 128`),
  ],
)
