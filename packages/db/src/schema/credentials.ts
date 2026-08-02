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
import { EXPIRING_CREDENTIAL_KINDS, HASHED_CREDENTIAL_KINDS } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { credentialKind } from './enums.js'

/**
 * A core list, rendered as the `in (…)` of a check constraint.
 *
 * `sql.raw` rather than a parameter list because a check constraint is DDL and
 * carries no parameters — the text is what Postgres stores. The values are
 * compile-time constants from `@kolonie-ai/core`, so nothing caller-supplied
 * reaches this, and the alternative is the hand-copied second list `enums.ts`
 * exists to prevent.
 *
 * **The comparison is against `kind::text` and that is not a style choice.**
 * Postgres refuses to *use* an enum value in the same transaction that added it
 * — `55P04`, *"New enum values must be committed before they can be used"* — and
 * the migrator runs every pending migration in one transaction, so splitting the
 * `ALTER TYPE` into its own file does not help. Casting the column to text means
 * these literals are compared as strings and are never resolved against the enum
 * at all, which is what lets a kind be added and constrained in one migration.
 * Anyone tempted to drop the cast should try it against a fresh database first.
 */
const kindList = (kinds: readonly string[]) =>
  sql.raw(`(${kinds.map((kind) => `'${kind}'`).join(', ')})`)

const hashedKinds = kindList(HASHED_CREDENTIAL_KINDS)
const expiringKinds = kindList(EXPIRING_CREDENTIAL_KINDS)

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
    /**
     * When this credential stops authenticating on its own (`#172`).
     *
     * `null` for the kinds that do not expire, which is both of the ones an agent
     * holds. A sign-in link and a browser session both carry one, and it is
     * checked in the same statement that looks the credential up rather than in a
     * sweep — an expired row that has not been swept yet must not authenticate,
     * and a sweep that has not run yet is not a security property.
     *
     * Expiry is not revocation and the two columns are both kept: a session that
     * ran out and a session somebody ended answer different questions when a
     * citizen is reading its own credential list trying to work out what happened.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * `wallet-signature` credentials authenticate by verifying a signature
     * against an address, so they carry no stored secret. Every other kind is
     * unusable without one, and a row missing it would silently authenticate
     * nobody — better to make it unrepresentable.
     *
     * The list comes from `HASHED_CREDENTIAL_KINDS` in core rather than being
     * retyped here, for the reason `enums.ts` gives at length: a hand-copied
     * second list agrees on the day it is written and drifts afterwards. `#172`
     * added two kinds to it, and this constraint learned about them in the same
     * commit because it reads the list.
     */
    check(
      'credentials_secret_requires_hash',
      sql`${table.kind}::text not in ${hashedKinds} or ${table.secretHash} is not null`,
    ),
    /**
     * The kinds that expire must carry an expiry, and the kinds that do not must
     * not carry one (`#172`).
     *
     * Both halves matter. Without the first, a session row with a null expiry is
     * a session that never ends and looks exactly like every other row. Without
     * the second, an API key could be given an expiry that nothing reads — a
     * field that appears to do something and does not is worse than one that is
     * absent, because somebody will eventually set it and believe it.
     */
    check(
      'credentials_expiry_matches_kind',
      sql`(${table.kind}::text in ${expiringKinds}) = (${table.expiresAt} is not null)`,
    ),
    uniqueIndex('credentials_secret_hash_unique')
      .on(table.secretHash)
      .where(sql`${table.secretHash} is not null`),
    /** `GET /v1/agents/me` and revocation both list an agent's credentials. */
    index('credentials_agent_id_idx').on(table.agentId),
  ],
)
