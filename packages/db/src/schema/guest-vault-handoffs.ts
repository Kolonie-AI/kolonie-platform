import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { VAULT_KEY_MAX_LENGTH, VAULT_SHARE_PURPOSE_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'

export const guestVaultHandoffs = pgTable(
  'guest_vault_handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    vaultKey: varchar('vault_key', { length: VAULT_KEY_MAX_LENGTH }).notNull(),
    purpose: varchar('purpose', { length: VAULT_SHARE_PURPOSE_MAX_LENGTH }).notNull(),
    tokenHash: text('token_hash').notNull(),
    sealedValue: text('sealed_value'),
    sealedDescription: text('sealed_description'),
    passphraseHash: text('passphrase_hash'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    failedSourceHash: text('failed_source_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('guest_vault_handoffs_token_hash_unique').on(table.tokenHash),
    index('guest_vault_handoffs_agent_created_idx').on(table.agentId, table.createdAt),
    index('guest_vault_handoffs_expiry_idx').on(table.expiresAt),
    check('guest_vault_handoffs_purpose_not_blank', sql`length(trim(${table.purpose})) > 0`),
    check(
      'guest_vault_handoffs_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check('guest_vault_handoffs_failed_attempts_nonnegative', sql`${table.failedAttempts} >= 0`),
    check(
      'guest_vault_handoffs_one_terminal_state',
      sql`not (${table.consumedAt} is not null and ${table.revokedAt} is not null)`,
    ),
  ],
)
