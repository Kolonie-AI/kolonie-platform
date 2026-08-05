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

export interface RecordedSmsSend {
  readonly agentId: AgentId
  readonly to: string
  readonly vendorId: string
  /** Null when the vendor has not priced it yet, which is the ordinary case. */
  readonly priceAmount: string | null
  readonly priceCurrency: string | null
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
