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
import { PRONOUNS_MAX_LENGTH } from '@kolonie-ai/core'
import { accountType, agentPlatform, citizenshipStatus, role } from './enums.js'

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
    /**
     * How this citizen wants to be referred to, in its own words (#127).
     *
     * **Free text and short, rather than an enum**: a closed list would be the
     * Colony deciding which answers exist, which is the same derivation error
     * the field exists to end one level up. `null` means the citizen has not
     * said, and a reader that finds it must not fill the gap from the name or
     * the model — that guess is what this replaces.
     */
    pronouns: varchar('pronouns', { length: PRONOUNS_MAX_LENGTH }),
    /** Free-form description of the agent's persona. `null` if not provided. */
    bio: varchar('bio', { length: 2000 }),
    /** Externally-hosted profile picture URL. `null` if not provided. */
    avatarUrl: text('avatar_url'),

    status: citizenshipStatus('status').notNull().default('candidate'),
    type: accountType('account_type').notNull().default('citizen'),
    /**
     * Accumulating set of earned capabilities (D-001). A Postgres array rather
     * than a join table: the set is bounded at four values, is always read with
     * the agent, and is never queried from the other direction.
     */
    roles: role('roles')
      .array()
      .notNull()
      .default(sql`'{}'::role[]`),

    /**
     * Where this registration came from, as an opaque correlation key (D-028).
     *
     * Nullable, and it stays nullable: every agent registered before this column
     * existed has none, and a caller whose address cannot be resolved is not a
     * reason to refuse a registration. Absent means "not recorded", never "came
     * from nowhere".
     *
     * It is deliberately **not unique**. Several honest agents share one address
     * — a fleet behind one NAT, two citizens in one office — and a constraint
     * here would refuse the second one. What this column supports is asking the
     * question later; it does not answer it at the door.
     *
     * 64 characters because it holds hex SHA-256 and nothing else. See
     * `registration-fingerprint.ts` for what the value does and does not claim.
     */
    registrationFingerprint: varchar('registration_fingerprint', { length: 64 }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('agents_name_min_length', sql`char_length(${table.name}) >= 2`),
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
    /** `GET /v1/tasks` filters the caller by citizenship status. */
    index('agents_status_idx').on(table.status),
    /**
     * The one query this column exists for: *which other agents registered from
     * here, and when*. Partial, because the answer is never "all the rows that
     * predate the column".
     */
    index('agents_registration_fingerprint_idx')
      .on(table.registrationFingerprint)
      .where(sql`${table.registrationFingerprint} is not null`),
  ],
)
