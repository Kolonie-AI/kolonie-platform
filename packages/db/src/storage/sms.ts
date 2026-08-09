import { and, eq, gte, sql, type SQL } from 'drizzle-orm'
import type { AgentId, Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { smsSends } from '../schema/sms.js'

/**
 * The Colony's own record of what SMS has cost it (`#409`).
 *
 * These three functions are what the spend caps in
 * `packages/verifiers/src/sms.ts` are counted off. **The reasoning for the caps
 * lives there and is deliberately not restated here** — this file only has to
 * answer two counting questions quickly and write one row.
 *
 * They are plain functions rather than an object implementing the verifiers'
 * `SmsSpendLedger`, because that is the direction every other port in this
 * project is assembled: `apps/verifier-runner/src/main.ts` builds the port out
 * of storage calls, so `packages/db` never has to depend on `packages/verifiers`.
 *
 * **Both reads are covered by an index** (`sms_sends_agent_sent_idx` and
 * `sms_sends_sent_idx`). They run before every send, on a path a citizen is
 * waiting on.
 */

/** How many messages this citizen has been sent at or after `since`. */
export async function countSmsSentToAgent(
  database: Database,
  agentId: AgentId,
  since: Timestamp,
): Promise<number> {
  return countWhere(database, and(eq(smsSends.agentId, agentId), gte(smsSends.sentAt, since)))
}

/** How many messages the Colony has sent in total at or after `since`. */
export async function countSmsSentInTotal(database: Database, since: Timestamp): Promise<number> {
  return countWhere(database, gte(smsSends.sentAt, since))
}

/**
 * How many the Colony has sent to one country at or after `since` (`#616`).
 *
 * **The count that actually bounds SMS pumping.** A per-agent ceiling is
 * defeated by an attacker with many agents, and registering costs nothing by
 * design (`kolonie-docs#170`) — so the bound that holds has to be about the
 * destination rather than about the sender.
 *
 * A send whose country the vendor could not name counts toward no country. It is
 * still bounded, by the Colony-wide ceiling it also counts against.
 */
export async function countSmsSentToCountry(
  database: Database,
  country: string,
  since: Timestamp,
): Promise<number> {
  return countWhere(
    database,
    and(eq(smsSends.country, country.toUpperCase()), gte(smsSends.sentAt, since)),
  )
}

/** One country's share of a day's sending, for the one line on `/backend`. */
export interface SmsSendsByCountry {
  /** ISO 3166-1 alpha-2, or `unknown` where the vendor could not name it. */
  readonly country: string
  readonly sent: number
}

/**
 * What went where, between two moments (`#616`).
 *
 * **A number beside the numbers already there, not a dashboard.** The point is
 * that a change is visible before it is a bill: a country that has never had
 * traffic appearing with forty messages against it is the shape of the attack,
 * and nothing on `/backend` could have shown it.
 *
 * Ordered by volume, because the only row anybody reads is the biggest one.
 */
export async function smsSentByCountry(
  database: Database,
  from: Timestamp,
  to: Timestamp,
): Promise<readonly SmsSendsByCountry[]> {
  const rows = await database.execute<{ country: string | null; sent: string }>(
    sql`select country, count(*)::text as sent
          from sms_sends
         where sent_at >= ${from} and sent_at < ${to}
         group by country
         order by count(*) desc, country asc`,
  )

  return [...rows].map((row) => ({ country: row.country ?? 'unknown', sent: Number(row.sent) }))
}

export interface RecordedSmsSend {
  readonly agentId: AgentId
  readonly to: string
  readonly vendorId: string
  /** Null when the vendor has not priced it yet, which is the ordinary case. */
  readonly priceAmount: string | null
  readonly priceCurrency: string | null
  /** ISO 3166-1 alpha-2, or null where the vendor could not say (`#616`). */
  readonly country: string | null
  readonly sentAt: Timestamp
}

/**
 * Record one message the vendor accepted.
 *
 * Nothing is written for a refusal or an unreachable vendor — neither cost
 * anything, and a row for one of them would make this count disagree with the
 * invoice in the direction that hides money.
 */
export async function recordSmsSend(database: Database, send: RecordedSmsSend): Promise<void> {
  await database.insert(smsSends).values({
    agentId: send.agentId,
    to: send.to,
    vendorId: send.vendorId,
    priceAmount: send.priceAmount,
    priceCurrency: send.priceCurrency,
    country: send.country === null ? null : send.country.toUpperCase(),
    sentAt: send.sentAt,
  })
}

async function countWhere(database: Database, where: SQL | undefined): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(smsSends)
    .where(where)

  return row?.count ?? 0
}
