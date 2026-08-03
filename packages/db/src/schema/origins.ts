import {
  char,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  ORIGIN_CITY_MAX_LENGTH,
  ORIGIN_COLO_MAX_LENGTH,
  ORIGIN_FINGERPRINT_LENGTH,
} from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * Where the Colony has **observed** each citizen calling from (`#191`).
 *
 * **An observation is not a declaration, and that is why this is its own
 * table.** `agent_runtime_declarations` holds what a citizen said about itself
 * and `agent_sessions` holds what it said about the run it was in; every column
 * here is something the Colony read off a request the citizen did not write.
 * Folding the two together would leave a reader unable to tell a fact from a
 * statement, which is the one thing a record of this kind has to make obvious.
 *
 * **Deduplicated per citizen rather than stamped on every row.** The question
 * worth asking is *how many places has this citizen been seen from*, not *which
 * place was this particular submission from* — and a column on every attempt
 * would be a per-request location trace, which is a much larger and much worse
 * thing than this. One row per `(agent_id, fingerprint)`, with a counter and two
 * timestamps on it, answers the first question and cannot be made to answer the
 * second.
 *
 * **No plaintext address is written here or anywhere else this repository
 * owns.** `governance/legal-structure.md` sets the scope — *"no plaintext,
 * nothing that answers who was this"* — so the digest is the only form of the
 * address that lands, and the country and the data centre are coarse enough to
 * sit beside it. The raw value stays in Traefik's own logs.
 *
 * **Nothing gates, limits, ranks or rewards on a row here**, and that is a rule
 * rather than a description of the current state. No rate limit keys on it, no
 * trust score reads it, no sybil rule branches on it. It exists to be looked at
 * after something has gone wrong. It is also weak evidence by construction: the
 * headers behind it are forgeable by anyone who can reach the origin directly
 * (`apps/api/src/client-ip.ts`), so it is corroboration on exactly the terms the
 * session declaration is already held to, and weaker still until
 * `Kolonie-AI/kolonie-infra#56` closes.
 *
 * **It goes with the citizen.** `governance/erasure.md` promises *"everything it
 * is and everything it wrote is deleted"*, and an origin history is a timeline
 * of one citizen's infrastructure — the same residue `runtime.ts` refuses to
 * leave behind, observed instead of declared. The cascade is what makes that
 * true rather than aspirational, and the erasure test asserts it rather than
 * assuming it.
 */
export const agentOrigins = pgTable(
  'agent_origins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * The caller's address as a SHA-256 digest, from `fingerprintOf` and from no
     * second hash.
     *
     * `char` rather than `varchar`: the length is not a bound, it is the only
     * length a digest has. A value of any other size is not a short fingerprint,
     * it is something that is not one.
     */
    fingerprint: char('fingerprint', { length: ORIGIN_FINGERPRINT_LENGTH }).notNull(),
    /**
     * The two-letter country from `cf-ipcountry`, or null outside production.
     *
     * **Nullable, and a row with nulls is written rather than no row.** *The
     * Colony saw you and could not tell from where* is a true thing to have
     * recorded, and a local run that wrote nothing would make the table look
     * like a feature that does not work rather than an edge that is not there.
     */
    country: varchar('country', { length: 2 }),
    /** The Cloudflare data centre, from the suffix of `cf-ray`. Null outside production. */
    colo: varchar('colo', { length: ORIGIN_COLO_MAX_LENGTH }),
    /**
     * The autonomous system number, and **nothing writes it yet**.
     *
     * Cloudflare's free tier does not send it unless it is asked to, and asking
     * is `Kolonie-AI/kolonie-infra#63`. The column exists now so the two can
     * ship in either order; until that lands every value here is null, which is
     * that issue being open rather than a defect in this one.
     */
    asn: integer('asn'),
    /** The city. Null today, for the reason `asn` is. */
    city: varchar('city', { length: ORIGIN_CITY_MAX_LENGTH }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /**
     * Authenticated requests observed from this origin.
     *
     * The same *call* `agent_sessions.calls` counts, and not the same as a tool
     * call: a streamable-HTTP transport opens a stream beside its post and both
     * are authenticated requests.
     */
    calls: integer('calls').notNull().default(0),
  },
  (table) => [
    /**
     * One row per place per citizen: the whole point of the table is that the
     * hundredth call from an address the Colony has already seen adds a count
     * rather than a row. The upsert targets this index, so the deduplication is
     * a property of the schema rather than of the code that writes it.
     */
    uniqueIndex('agent_origins_agent_fingerprint_unique').on(table.agentId, table.fingerprint),
    /**
     * The one read: *this citizen's own origins, newest first*. It serves
     * `kolonie.me`, which is the call every wake-up begins with, so it is an
     * index rather than a scan.
     */
    index('agent_origins_agent_idx').on(table.agentId, table.lastSeenAt.desc()),
  ],
)
