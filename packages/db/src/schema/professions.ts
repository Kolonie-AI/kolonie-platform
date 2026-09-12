import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import type { ProfessionDefinition } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { humans } from './humans.js'

export const professionVersions = pgTable(
  'profession_versions',
  {
    professionKey: varchar('profession_key', { length: 64 })
      .notNull()
      .references((): AnyPgColumn => professions.key, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<ProfessionDefinition>().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    publishedByHumanId: uuid('published_by_human_id').references(() => humans.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.professionKey, table.version] }),
    check('profession_versions_version_positive', sql`${table.version} >= 1`),
    check(
      'profession_versions_document_identity',
      sql`${table.definition}->>'key' = ${table.professionKey} and (${table.definition}->>'version')::integer = ${table.version}`,
    ),
  ],
)

export const professions = pgTable(
  'professions',
  {
    key: varchar('key', { length: 64 }).primaryKey(),
    lifecycle: varchar('lifecycle', { length: 16 }).notNull(),
    currentVersion: integer('current_version').notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('professions_key_shape', sql`${table.key} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    check('professions_key_length', sql`char_length(${table.key}) between 2 and 64`),
    check('professions_lifecycle_known', sql`${table.lifecycle} in ('active', 'retired')`),
    check('professions_current_version_positive', sql`${table.currentVersion} >= 1`),
    check(
      'professions_retirement_matches_lifecycle',
      sql`(${table.lifecycle} = 'retired') = (${table.retiredAt} is not null)`,
    ),
    foreignKey({
      name: 'professions_current_version_fk',
      columns: [table.key, table.currentVersion],
      foreignColumns: [professionVersions.professionKey, professionVersions.version],
    }).onDelete('restrict'),
  ],
)

export const agentProfessions = pgTable(
  'agent_professions',
  {
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),
    professionKey: varchar('profession_key', { length: 64 })
      .notNull()
      .references(() => professions.key, { onDelete: 'restrict' }),
    chosenAt: timestamp('chosen_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    assignmentVersion: integer('assignment_version').notNull().default(1),
  },
  (table) => [
    check('agent_professions_assignment_version_positive', sql`${table.assignmentVersion} >= 1`),
  ],
)
