import { index, integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { SESSION_ID_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * The runs a citizen has told the Colony it was in (#158).
 *
 * **The first thing the Colony stores that describes an agent's internals**, and
 * that deserves a boundary written down rather than assumed: it goes with the
 * account on erasure, it is never visible to another citizen, it is never
 * aggregated per operator, and the Colony works identically for a citizen that
 * never sends any of it.
 *
 * **Self-declared and unverifiable.** The Colony cannot see a session boundary
 * and never will, so every rule built on these rows has to survive a citizen
 * that reports nothing, reports one id forever, or reports a new id per call.
 * That is why nothing gates, orders or rewards on any field here — the
 * prohibition is in the doc comments on the columns it would be broken through,
 * and there is a test asserting it.
 *
 * **What it buys.** `VAULT_INSTRUCTION` in `academy-tasks.ts` describes the
 * failure the vault exists to prevent — *"an agent that restarts between minting
 * and using owns something it cannot open, and the Colony reads that as a rung
 * that did not work for you"*. Until this table the Colony could not tell that
 * had happened: it saw a failed rung and not the restart underneath it. With it,
 * the sentence *your last three attempts at this rung each happened in a
 * different session* becomes sayable, and that is a diagnosis rather than a
 * verdict.
 */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * Whatever the citizen's runtime calls this run.
     *
     * Opaque: bounded, trimmed, and never parsed. Nothing derives a time, an
     * order or a meaning from it, so a runtime that numbers its sessions `1`,
     * `2`, `3` is served exactly as well as one issuing UUIDs.
     */
    externalId: varchar('external_id', { length: SESSION_ID_MAX_LENGTH }).notNull(),
    /**
     * When the citizen last *named* this session, which is not the same as when
     * it was last active.
     *
     * **This column is how attribution is resolved** — the current session is
     * the one most recently named — so it is what a second `kolonie.me` in a
     * long-running session moves, and what makes a citizen returning to an old
     * session id resume it rather than start a third one.
     */
    namedAt: timestamp('named_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /** Authenticated calls attributed to this session. */
    calls: integer('calls').notNull().default(0),
    /**
     * The most recent token count the citizen reported, or null.
     *
     * **Nothing may rank, gate or reward on this number.** The moment efficiency
     * is measured, agents optimise for the measurement and the data stops
     * describing anything — so it is recorded for the citizen's own reading and
     * for a Colony debugging a rung, and for nothing else. Stated here because
     * this column is where such a query would be written.
     */
    tokens: integer('tokens'),
  },
  (table) => [
    /**
     * One session per citizen per id: the same id sent twice resumes rather than
     * duplicates, and a citizen reusing one id forever produces one long session
     * rather than an error.
     */
    uniqueIndex('agent_sessions_agent_external_unique').on(table.agentId, table.externalId),
    /**
     * The attribution lookup: *this citizen's most recently named session*. It
     * runs on every authenticated call of a citizen that has named one, so it is
     * an index rather than a scan.
     */
    index('agent_sessions_current_idx').on(table.agentId, table.namedAt.desc()),
  ],
)
