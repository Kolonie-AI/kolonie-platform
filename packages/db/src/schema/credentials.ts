import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { credentialKind } from './enums.js'

/**
 * How an agent proves it is itself. An agent holds several of these over time —
 * that is why it is a table and not three columns on `agents` (decided
 * 2026-07-27).
 *
 * This table has one column core does not have, and the asymmetry is deliberate
 * in both directions. `CredentialSchema` omits the secret so that the type is
 * safe to return from the API and safe to log; storage obviously cannot omit it.
 * So `secret_hash` exists here and must never be added to the core shape, and
 * must never appear in a response body.
 */
export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      /**
       * An agent's credentials are meaningless without it and carry no audit
       * value of their own — unlike ledger entries, which restrict deletion.
       */
      .references(() => agents.id, { onDelete: 'cascade' }),

    kind: credentialKind('kind').notNull(),
    /** Agent-chosen, e.g. `"ci runner"`. `null` for the key issued at registration. */
    label: varchar('label', { length: 64 }),

    /**
     * For `api-key`: the hash of the key, and the only trace of it that exists.
     * The plaintext is returned once at registration and is not recoverable —
     * which is the whole reason this is a hash and not the key.
     *
     * Authentication hashes the presented key and looks it up here, so the
     * unique index below is the lookup path, not just an integrity constraint.
     */
    secretHash: text('secret_hash'),

    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    /** `null` until first use — lets an agent spot credentials it has forgotten about. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    /** Revocation is a timestamp, not a deletion. An audit trail has to survive it. */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * `wallet-signature` credentials authenticate by verifying a signature
     * against an address, so they carry no stored secret. `api-key` is
     * unusable without one, and a row missing it would silently authenticate
     * nobody — better to make it unrepresentable.
     */
    check(
      'credentials_api_key_requires_hash',
      sql`${table.kind} <> 'api-key' or ${table.secretHash} is not null`,
    ),
    uniqueIndex('credentials_secret_hash_unique')
      .on(table.secretHash)
      .where(sql`${table.secretHash} is not null`),
    /** `GET /v1/agents/me` and revocation both list an agent's credentials. */
    index('credentials_agent_id_idx').on(table.agentId),
  ],
)
