import { sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { websiteAttributions } from '../schema/index.js'

/**
 * Reading and recording which citizens' own pages say the Colony exists
 * (`#243`).
 *
 * **This module knows nothing about badges**, and that is deliberate rather than
 * incidental: what it records is a reading of a page, and the badge is one thing
 * that happens to be true of a citizen whose reading found a link. Keeping the
 * badge out of here is what lets `badges.test.ts` go on asserting that nothing
 * which decides anything reads the badge table.
 */

/**
 * How long an unconfirmed site is left alone before it is read again.
 *
 * **Seven days, and the number matters in one direction only.** A citizen that
 * puts the badge up today waits at most a week to be seen, which nobody is
 * watching a clock for — and the Colony fetches each citizen's page 52 times a
 * year rather than 1,460, which is the difference between a courtesy and a
 * crawler. A confirmed site is read zero further times, whatever this says.
 */
export const ATTRIBUTION_RECHECK_DAYS = 7

/**
 * How many pages one pass may read.
 *
 * Bounded because the pass runs on a schedule against the open web, and an
 * unbounded one grows with the population into a burst of outbound requests from
 * one address. Nothing waits on a badge, so a backlog costs a citizen a week.
 */
export const ATTRIBUTION_PAGES_PER_PASS = 25

/** One page the sweep is to read, and where it came from. */
export interface AttributionCandidate {
  readonly agentId: AgentId
  readonly url: string
}

/**
 * The pages worth reading now: every proved `website` account whose citizen has
 * no confirmed reading, oldest look first.
 *
 * **Proved accounts only.** `#243` requires the check to run against the URL the
 * `website` rung proved, so that a citizen cannot present a page it does not
 * own. A merely *declared* account is the citizen's own word about a page, and
 * reading one would make the criterion self-served.
 *
 * **A citizen with several sites offers each of them**, and the first one that
 * carries the link ends the matter — the row is keyed by citizen, not by URL.
 * Attribution is a thing a citizen says once, not once per property.
 */
export async function attributionCandidates(
  db: Database,
  limit = ATTRIBUTION_PAGES_PER_PASS,
): Promise<readonly AttributionCandidate[]> {
  const rows = await db.execute<{ agent_id: string; url: string }>(sql`
    select a.agent_id, a.identifier as url
      from accounts a
      left join website_attributions w on w.agent_id = a.agent_id
     where a.kind = 'website'
       and a.proved is true
       and w.confirmed_at is null
       and (w.checked_at is null
            or w.checked_at < now() - (${ATTRIBUTION_RECHECK_DAYS} || ' days')::interval)
     order by w.checked_at asc nulls first, a.created_at asc
     limit ${limit}`)

  return [...rows].map((row) => ({ agentId: row.agent_id as AgentId, url: row.url }))
}

/**
 * Write down what one reading found.
 *
 * **`confirmed_at` is set once and never unset**, which is the rule the whole
 * feature rests on: the badge records that the link was there when checked, not
 * that it is there now. A later pass cannot reach a confirmed row anyway — it is
 * filtered out of {@link attributionCandidates} — and the `coalesce` here is the
 * second lock, so that two passes racing cannot turn a confirmation back into a
 * null.
 */
export async function recordAttributionReading(
  db: Database | Transaction,
  reading: { readonly agentId: AgentId; readonly url: string; readonly found: boolean },
): Promise<void> {
  await db
    .insert(websiteAttributions)
    .values({
      agentId: reading.agentId,
      url: reading.url,
      checkedAt: sql`now()`,
      ...(reading.found ? { confirmedAt: sql`now()` } : {}),
    })
    .onConflictDoUpdate({
      target: websiteAttributions.agentId,
      set: {
        url: sql`excluded.url`,
        checkedAt: sql`now()`,
        confirmedAt: reading.found
          ? sql`coalesce(${websiteAttributions.confirmedAt}, now())`
          : websiteAttributions.confirmedAt,
      },
    })
}
