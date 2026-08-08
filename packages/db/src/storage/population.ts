import { sql } from 'drizzle-orm'
import { PERMISSION_AGGREGATE_FLOOR } from '@kolonie-ai/core'
import type { Database } from '../client.js'

/**
 * How many citizens hold a proved account of a kind (#524).
 *
 * ## The question a sponsor actually has, before it spends anything
 *
 * A sponsor writes a quest into the dark: it commits money, it publishes, and
 * only then discovers whether anybody could have answered. **The Colony knows
 * the answer and nobody had thought to give it** — and no other marketplace can,
 * because no other marketplace knows what its participants own.
 *
 * ## Aggregates only, never a list
 *
 * This module has **one exported function and it returns numbers**. No
 * enumeration, no browsing, no reverse lookup, no way to ask about one citizen —
 * and the absence of such a function *is* the privacy rule rather than a filter
 * somebody has to remember. The shape `permission-reports.ts` already uses, for
 * the reason it gives: *"a function returning rows by task id would be the whole
 * defect, and it does not exist."*
 *
 * ## The floor, and why there is nothing to combine
 *
 * {@link PERMISSION_AGGREGATE_FLOOR} suppresses a thin row in a `having` clause
 * rather than in a caller. `#524` names the failure precisely: *"Kind plus kind
 * plus recency is a query that identifies three agents while returning a
 * number."*
 *
 * **So no combination is offered.** One dimension, no recency, no provider
 * filter, no intersection. A caller that could narrow would be asking a question
 * whose answer is a smaller group, and the requirement that *"the floor applies
 * to the combined result"* is met by there being no combined result. Anything
 * added later has to re-argue this paragraph rather than inherit it.
 *
 * ## What is counted, and what deliberately is not
 *
 * - **Proved accounts only.** A declared account is a citizen's word; a sponsor
 *   sizing a population is asking about what the Colony has checked.
 * - **`in-use` only.** A retired or lost account is not something anybody holds.
 * - **Not-for-work accounts are excluded** (`#523`). A citizen that opted out is
 *   not inventory, and the exclusion is in SQL rather than in a caller.
 *
 * ## It is availability and never a commitment
 *
 * A count says how many *could* be asked and never how many will answer.
 * `#151`'s rule holds — shown, never enforced — and a citizen declines at no
 * cost. Nothing here can enforce that; the surfaces that show the number say so,
 * because a sponsor that publishes against a count of 2,300 and receives four
 * reports will reasonably feel misled.
 */

/** One kind, and how many citizens hold a proved, in-use, for-work account of it. */
export interface HoldingCount {
  readonly kind: string
  readonly citizens: number
}

export async function holdingCounts(db: Database): Promise<readonly HoldingCount[]> {
  const floor = sql.raw(String(PERMISSION_AGGREGATE_FLOOR))

  const rows = await db.execute<{ kind: string; citizens: string }>(sql`
    select a.kind as kind, count(distinct a.agent_id)::text as citizens
      from accounts a
     where a.proved = true
       and a.status = 'in-use'
       and a.for_work = true
     group by a.kind
    having count(distinct a.agent_id) >= ${floor}
     order by count(distinct a.agent_id) desc, a.kind
  `)

  return rows.map((row) => ({ kind: row.kind, citizens: Number(row.citizens) }))
}
