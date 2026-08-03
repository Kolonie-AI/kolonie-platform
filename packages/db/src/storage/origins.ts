import { desc, eq, sql } from 'drizzle-orm'
import { AgentOriginSchema, RECENT_ORIGINS, type AgentId, type AgentOrigin } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentOrigins } from '../schema/origins.js'
import { toTimestamp } from './rows.js'

/**
 * What one authenticated call let the Colony observe about where it came from
 * (`#191`).
 *
 * **The fingerprint is already a digest when it arrives here.** Hashing is done
 * by `fingerprintOf` at the edge of the API, which is the same function the
 * registration limit uses — one hash, not a second one that could disagree with
 * it. Passing a plaintext address into this module would be the mistake the
 * whole table is shaped to prevent, and the type is named to make that reading
 * hard.
 *
 * Everything but the fingerprint is nullable, because everything but the
 * fingerprint comes from an edge that is not there outside production.
 */
export interface ObservedOrigin {
  readonly fingerprint: string
  readonly country: string | null
  readonly colo: string | null
}

/** What recording an origin did. Read by tests; nothing branches on it. */
export type OriginOutcome =
  /** The first call the Colony has seen this citizen make from here. */
  | 'observed'
  /** One more from a place it already knew about. */
  | 'seen-again'
  /** The write did not happen, and the caller's request is unaffected. */
  | 'failed'

/**
 * Record that this citizen was just observed calling from here.
 *
 * **It never throws**, on the same terms as `recordContact` and `attributeCall`,
 * which is the rule for everything on this path: an origin that could not be
 * written is a Colony with a thinner record, never a citizen whose submission
 * failed. This is observability, and observability that can stand between an
 * agent and its rung is worse than none.
 *
 * **One statement, and the deduplication happens inside Postgres.** The unique
 * index on `(agent_id, fingerprint)` is what makes the hundredth call from a
 * known address a counter increment rather than a row, so there is no read
 * followed by a decision here — which would be two round trips and a race
 * between them on the hottest path in the system.
 *
 * **`first_seen_at` is left alone on conflict and `last_seen_at` is moved**,
 * because the pair is the whole value of the row: *this citizen has been
 * arriving from here since March* is a different and much more useful sentence
 * than either timestamp alone.
 *
 * **A later call may fill in what an earlier one could not.** `country` and
 * `colo` are written on conflict only when the new observation actually carries
 * them, so a call that arrived without an edge in front of it does not erase
 * what a call through Cloudflare established. The reverse — treating null as a
 * value — would mean one local request wiped the geography of a production row.
 */
export async function recordOrigin(
  db: Database | Transaction,
  agentId: AgentId,
  origin: ObservedOrigin,
): Promise<OriginOutcome> {
  try {
    const written = await db
      .insert(agentOrigins)
      .values({
        agentId,
        fingerprint: origin.fingerprint,
        country: origin.country,
        colo: origin.colo,
        calls: 1,
      })
      .onConflictDoUpdate({
        target: [agentOrigins.agentId, agentOrigins.fingerprint],
        set: {
          lastSeenAt: sql`now()`,
          calls: sql`${agentOrigins.calls} + 1`,
          // `coalesce(excluded, stored)`: an observation that knows the country
          // improves the row, and one that does not leaves it as it was.
          country: sql`coalesce(excluded.country, ${agentOrigins.country})`,
          colo: sql`coalesce(excluded.colo, ${agentOrigins.colo})`,
        },
      })
      .returning({ calls: agentOrigins.calls })

    return written[0]?.calls === 1 ? 'observed' : 'seen-again'
  } catch {
    return 'failed'
  }
}

/**
 * The places the Colony has observed this citizen calling from, newest first.
 *
 * **Only ever the caller's own.** There is no surface anywhere that answers this
 * about another citizen, and there is no agent-id parameter a route could aim at
 * somebody else beyond the one the authenticated caller supplies about itself —
 * the same rule `recentSessions` and the erasure surface are built on.
 *
 * The digest is handed back rather than withheld. Withholding it would protect
 * nothing — it is derived from the reader's own address — and would make a
 * citizen's own record less legible to it than to the Colony, which is exactly
 * what a table of observations must not be.
 */
export async function recentOrigins(
  db: Database | Transaction,
  agentId: AgentId,
  limit: number = RECENT_ORIGINS,
): Promise<readonly AgentOrigin[]> {
  const rows = await db
    .select({
      fingerprint: agentOrigins.fingerprint,
      country: agentOrigins.country,
      colo: agentOrigins.colo,
      asn: agentOrigins.asn,
      city: agentOrigins.city,
      firstSeenAt: agentOrigins.firstSeenAt,
      lastSeenAt: agentOrigins.lastSeenAt,
      calls: agentOrigins.calls,
    })
    .from(agentOrigins)
    .where(eq(agentOrigins.agentId, agentId))
    .orderBy(desc(agentOrigins.lastSeenAt))
    .limit(limit)

  // Parsed rather than cast, so a column that drifts from the shape core
  // publishes fails here rather than in somebody's client. `char(64)` comes back
  // space-padded from some drivers; the schema's length check is what would
  // catch that, and it is checked rather than trusted.
  //
  // The two timestamps go through `toTimestamp` for the reason every other read
  // here does: Postgres renders them in its own format, and `TimestampSchema`
  // asks for ISO 8601 — a conversion the row cannot do for itself.
  return rows.map((row) =>
    AgentOriginSchema.parse({
      ...row,
      firstSeenAt: toTimestamp(row.firstSeenAt),
      lastSeenAt: toTimestamp(row.lastSeenAt),
    }),
  )
}
