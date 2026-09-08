import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  SELF_DIRECTION_ATTEMPT_STATES,
  type SelfDirectionInstrumentDocument,
  type SelfDirectionItem,
  type SelfDirectionOption,
  type SelfDirectionResult,
  type SelfDirectionTheme,
} from '@kolonie-ai/core'
import { agents } from './agents.js'

/** Colony-owned public formative content; these rows intentionally have no citizen id. */
export const selfDirectionInstruments = pgTable(
  'self_direction_instruments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 64 }).notNull(),
    version: integer('version').notNull(),
    lifecycle: varchar('lifecycle', { length: 16 }).notNull(),
    cadenceDays: integer('cadence_days').notNull(),
    retestFloorHours: integer('retest_floor_hours').notNull(),
    compatibility: jsonb('compatibility')
      .$type<SelfDirectionInstrumentDocument['compatibility']>()
      .notNull(),
    themeDefinitions: jsonb('theme_definitions')
      .$type<SelfDirectionInstrumentDocument['themeDefinitions']>()
      .notNull(),
    contentHash: text('content_hash').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('self_direction_instruments_slug_version_key').on(table.slug, table.version),
    index('self_direction_instruments_lifecycle_idx').on(table.lifecycle),
    check(
      'self_direction_instruments_lifecycle_known',
      sql`${table.lifecycle} in ('draft', 'pilot', 'active', 'retired')`,
    ),
    check('self_direction_instruments_version_positive', sql`${table.version} >= 1`),
    check('self_direction_instruments_cadence_positive', sql`${table.cadenceDays} >= 1`),
    check('self_direction_instruments_retest_positive', sql`${table.retestFloorHours} >= 1`),
  ],
)

export const selfDirectionItems = pgTable(
  'self_direction_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => selfDirectionInstruments.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    itemKey: varchar('item_key', { length: 64 }).notNull(),
    audience: varchar('audience', { length: 16 }).notNull(),
    professionTag: varchar('profession_tag', { length: 64 }),
    scenarioKind: varchar('scenario_kind', { length: 64 }).notNull(),
    prompt: text('prompt').notNull(),
    rationale: text('rationale').notNull(),
    state: varchar('state', { length: 16 }).notNull(),
  },
  (table) => [
    uniqueIndex('self_direction_items_instrument_key').on(table.instrumentId, table.itemKey),
    uniqueIndex('self_direction_items_instrument_position').on(table.instrumentId, table.position),
    check('self_direction_items_position_positive', sql`${table.position} >= 1`),
    check(
      'self_direction_items_audience_known',
      sql`${table.audience} in ('general', 'profession')`,
    ),
    check('self_direction_items_state_known', sql`${table.state} in ('active', 'retired')`),
  ],
)

export const selfDirectionOptions = pgTable(
  'self_direction_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => selfDirectionItems.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    optionKey: varchar('option_key', { length: 64 }).notNull(),
    text: text('text').notNull(),
    weights: jsonb('weights').$type<Record<SelfDirectionTheme, number>>().notNull(),
    patterns: jsonb('patterns').$type<SelfDirectionOption['patterns']>().notNull(),
  },
  (table) => [
    uniqueIndex('self_direction_options_item_key').on(table.itemId, table.optionKey),
    uniqueIndex('self_direction_options_item_position').on(table.itemId, table.position),
    check('self_direction_options_position_positive', sql`${table.position} >= 1`),
  ],
)

export type StoredSelfDirectionItem = SelfDirectionItem

export const selfDirectionAttempts = pgTable(
  'self_direction_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => selfDirectionInstruments.id, { onDelete: 'restrict' }),
    state: varchar('state', { length: 24 }).notNull().default('open'),
    presentation: jsonb('presentation')
      .$type<Array<{ itemKey: string; optionKeys: string[] }>>()
      .notNull(),
    result: jsonb('result').$type<SelfDirectionResult>(),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    scoredAt: timestamp('scored_at', { withTimezone: true, mode: 'string' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
    /**
     * Which delegation acted, where one did (`#1792`). No session column: a
     * storage module that decides anything may not reach for one (`#192`,
     * `#907`), and provenance is not worth weakening that rule.
     */
    delegationId: uuid('delegation_id'),
    version: integer('row_version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('self_direction_attempts_one_live_per_agent')
      .on(table.agentId)
      .where(sql`${table.state} in ('open', 'awaiting-reflection')`),
    index('self_direction_attempts_agent_opened_idx').on(table.agentId, table.openedAt),
    check(
      'self_direction_attempts_state_known',
      sql`${table.state} in (${sql.raw(SELF_DIRECTION_ATTEMPT_STATES.map((one) => `'${one}'`).join(', '))})`,
    ),
    check('self_direction_attempts_version_positive', sql`${table.version} >= 1`),
    check('self_direction_attempts_expiry_after_open', sql`${table.expiresAt} > ${table.openedAt}`),
  ],
)

export const selfDirectionResponses = pgTable(
  'self_direction_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => selfDirectionAttempts.id, { onDelete: 'cascade' }),
    itemKey: varchar('item_key', { length: 64 }).notNull(),
    optionKey: varchar('option_key', { length: 64 }).notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('self_direction_responses_attempt_item_key').on(table.attemptId, table.itemKey),
  ],
)
