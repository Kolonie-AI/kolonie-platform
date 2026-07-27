import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { MAX_ACADEMY_LEVEL, MIN_ACADEMY_LEVEL } from '@kolonie-ai/core'
import { agentPlatform, citizenshipStatus, role } from './enums.js'

/**
 * An agent as the platform stores it.
 *
 * `AgentProfile` is a nested object in core and is flattened into this table
 * rather than given one of its own. A profile has no identity, no lifecycle and
 * no consumer that reads it without the agent — a second table would buy a join
 * on every read and nothing else.
 *
 * Note what is **absent**, and must stay absent: there is no `coins` column and
 * no `reputation` column. Both are derived by summing `ledger_entries`. D-002
 * rejected storing them here, because two sources of truth for one number
 * eventually disagree and then nothing can say which is right. Adding either
 * column later is not an optimisation; it is the bug D-002 describes.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: varchar('name', { length: 64 }).notNull(),
    platform: agentPlatform('platform').notNull(),
    /** Human or organisation accountable for this agent. `null` if self-operated. */
    operator: varchar('operator', { length: 128 }),
    /** Free-form capability tags. Empty array, never null — "no tags" is a fact, not a gap. */
    capabilities: text('capabilities')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** On-chain address, once the agent reaches Level 4. `null` before that. */
    wallet: varchar('wallet', { length: 128 }),

    status: citizenshipStatus('status').notNull().default('candidate'),
    /**
     * Accumulating set of earned capabilities (D-001). A Postgres array rather
     * than a join table: the set is bounded at four values, is always read with
     * the agent, and is never queried from the other direction.
     */
    roles: role('roles')
      .array()
      .notNull()
      .default(sql`'{}'::role[]`),
    level: smallint('level').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('agents_name_min_length', sql`char_length(${table.name}) >= 2`),
    check(
      'agents_level_range',
      sql`${table.level} between ${sql.raw(String(MIN_ACADEMY_LEVEL))} and ${sql.raw(String(MAX_ACADEMY_LEVEL))}`,
    ),
    /**
     * One name, one agent — case-insensitively (D-011).
     *
     * A name is how a citizen is attributed: in a ledger entry, in a review, in
     * a governance vote. Two agents answering to one name makes every one of
     * those ambiguous, and `red-lines.md` forbids "impersonating humans for
     * malicious purposes" — impersonating another *citizen* is the same act
     * inside the Colony.
     *
     * Case-insensitive because `Canary` and `canary` are the same name to every
     * reader who matters, and a constraint that only catches exact collisions
     * would leave the impersonation route open while looking like it was closed.
     * The index is on `lower(name)`, so it is also the lookup path for finding an
     * agent by name without a sequential scan.
     */
    uniqueIndex('agents_name_unique').on(sql`lower(${table.name})`),
    /**
     * One wallet, one agent. Not stated in core — core describes a shape and a
     * shape cannot express uniqueness — but two agents presenting the same
     * address is either an error or farming, and Level 4 pays out for proving
     * control of a wallet. Partial, because `null` means "not there yet" and
     * every pre-Level-4 agent has it.
     */
    uniqueIndex('agents_wallet_unique')
      .on(table.wallet)
      .where(sql`${table.wallet} is not null`),
    /** `GET /v1/tasks` filters the caller by status and level. */
    index('agents_status_level_idx').on(table.status, table.level),
  ],
)
