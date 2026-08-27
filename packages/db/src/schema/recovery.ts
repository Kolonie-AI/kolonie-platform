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
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts.js'
import { agents } from './agents.js'
import { credentials } from './credentials.js'

/**
 * The one account a citizen chose in advance as its second door (`#1684`).
 *
 * One row per citizen makes "exactly one" a property of the schema. Replacing
 * the account updates this row and restarts the delay; the account thread keeps
 * the notification written to the earlier factor.
 */
export const recoveryNominations = pgTable(
  'recovery_nominations',
  {
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    nominatedAt: timestamp('nominated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    effectiveAt: timestamp('effective_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('recovery_nominations_account_unique').on(table.accountId),
    check(
      'recovery_nominations_effective_after_nomination',
      sql`${table.effectiveAt} > ${table.nominatedAt}`,
    ),
  ],
)

/**
 * One unauthenticated attempt to recover a named citizen.
 *
 * Issuance is the attempt and therefore the rate-limit record. The nonce is
 * consumed on every answer, including a bad signature, so one issued challenge
 * buys one verification and no oracle can be ground through it.
 */
export const recoveryChallenges = pgTable(
  'recovery_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    nonce: text('nonce').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('recovery_challenges_nonce_unique').on(table.nonce),
    check(
      'recovery_challenges_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    index('recovery_challenges_attempts_idx').on(table.agentId, table.createdAt),
    index('recovery_challenges_open_idx')
      .on(table.agentId, table.expiresAt)
      .where(sql`${table.consumedAt} is null`),
  ],
)

/**
 * The citizen's private, permanent trace that a recovery completed.
 *
 * It is append-only because a second recovery does not make the first one
 * unhappen. No public record joins this table; `kolonie.wakeup` and
 * `kolonie.me.history` are its two readers.
 *
 * **What the database guarantees, exactly** (`#1721`): a trigger refuses
 * `UPDATE` on an existing row, so no statement — a storage path, a maintenance
 * session, a psql prompt — can rewrite a completed recovery. `DELETE` is
 * deliberately **not** refused, and that is not a gap in the guarantee but its
 * shape: erasure takes everything a citizen ever wrote, it reaches these rows
 * by cascade from `agents`, and a row-level delete guard would refuse erasure
 * itself. `account_entries` states the same pair for the same reason and this
 * is deliberately its twin rather than a second mechanism.
 *
 * So the two halves are held in two different places, and only one of them is a
 * constraint. *Cannot be changed* is the database's promise, and it holds
 * against code nobody has written yet. *Cannot be removed one at a time* is a
 * property of the storage surface — this module exports no operation that
 * deletes a single recovery — and it is a promise about today's code, tested by
 * reading the module's own exports rather than by asking PostgreSQL, because
 * PostgreSQL is not the thing making it.
 */
export const credentialRecoveries = pgTable(
  'credential_recoveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    strandedVaultEntries: integer('stranded_vault_entries').notNull(),
    recoveredAt: timestamp('recovered_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('credential_recoveries_stranded_non_negative', sql`${table.strandedVaultEntries} >= 0`),
    index('credential_recoveries_agent_time_idx').on(table.agentId, table.recoveredAt),
  ],
)
