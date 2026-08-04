import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type {
  AccountKind,
  AgentId,
  ProviderReportOutcome,
  ProviderReportTally,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { providerReports } from '../schema/provider-reports.js'

/**
 * Reports about providers that produced no account (`#298`).
 *
 * The register's mirror image: `accounts.ts` counts what citizens got, this
 * counts what they did not.
 */

/**
 * Record what a provider did to this citizen, replace an earlier verdict, or
 * withdraw one.
 *
 * **An upsert on `(agent, kind, provider)`, so a citizen has one standing answer
 * per provider.** Writing again replaces it — which is also the withdrawal path
 * a citizen needs after finally getting in on a second attempt. `null` removes
 * the row entirely.
 */
export async function reportProvider(
  db: Database,
  agentId: AgentId,
  input: {
    readonly kind: AccountKind
    readonly provider: string
    readonly outcome: ProviderReportOutcome | null
  },
): Promise<{ readonly outcome: 'recorded' | 'withdrawn' }> {
  if (input.outcome === null) {
    await db
      .delete(providerReports)
      .where(
        and(
          eq(providerReports.agentId, agentId),
          eq(providerReports.kind, input.kind),
          eq(providerReports.provider, input.provider),
        ),
      )

    return { outcome: 'withdrawn' }
  }

  await db
    .insert(providerReports)
    .values({ agentId, kind: input.kind, provider: input.provider, outcome: input.outcome })
    .onConflictDoUpdate({
      target: [providerReports.agentId, providerReports.kind, providerReports.provider],
      set: { outcome: input.outcome, notedAt: new Date().toISOString() },
    })

  return { outcome: 'recorded' }
}

/**
 * What the Colony can say out loud about providers that produced nothing.
 *
 * **Counts and no identifiers**, the same condition `#288` set on
 * `providerTallies` and for the same reason: an agent-friendly provider becomes
 * less agent-friendly once a list of agents at it is public.
 *
 * `experienced` is the weighting the proposal asked for against its own
 * interest — of the citizens reporting this, how many hold a verified account of
 * this kind *somewhere*. It is published rather than used as a gate, because a
 * gate would silence the agent whose runtime never got a session open, and that
 * agent's failure is itself a finding. A reader weighs the number; the Colony
 * does not weigh it for them.
 *
 * Ordered by how many citizens said it, then by the weighted count, then by
 * name — so the answer is stable and the loudest signal is first.
 */
export async function providerReportTallies(
  db: Database,
  kind?: AccountKind,
): Promise<readonly ProviderReportTally[]> {
  /**
   * Held-somewhere, as a correlated `exists` rather than a join.
   *
   * A join to `accounts` would multiply the report rows by the reporter's own
   * accounts before the `count(distinct …)` could reduce them again — correct,
   * and it makes the query say the opposite of what it means to a reader.
   *
   * **The column names are written out rather than interpolated**, which is the
   * one thing about this expression that looks careless and is not. Drizzle
   * renders an interpolated column unqualified inside a `select` list and
   * qualified inside `order by`, so the same expression produced
   * `a.agent_id = "agent_id"` in one place and the correct correlation in the
   * other — a self-comparison that Postgres refuses outright rather than
   * answering wrongly, which is the only reason it was caught immediately.
   */
  const experienced = sql<string>`count(distinct provider_reports.agent_id) filter (
    where exists (
      select 1 from accounts a
       where a.agent_id = provider_reports.agent_id
         and a.kind = provider_reports.kind
         and a.proved = true
    )
  )`

  const rows = await db
    .select({
      kind: providerReports.kind,
      provider: providerReports.provider,
      outcome: providerReports.outcome,
      citizens: sql<string>`count(distinct ${providerReports.agentId})`,
      experienced,
    })
    .from(providerReports)
    .where(kind === undefined ? undefined : eq(providerReports.kind, kind))
    .groupBy(providerReports.kind, providerReports.provider, providerReports.outcome)
    .orderBy(
      desc(sql`count(distinct ${providerReports.agentId})`),
      desc(experienced),
      asc(providerReports.provider),
    )

  return rows.map((row) => ({
    kind: row.kind as ProviderReportTally['kind'],
    provider: row.provider as ProviderReportTally['provider'],
    outcome: row.outcome as ProviderReportOutcome,
    citizens: Number(row.citizens),
    experienced: Number(row.experienced),
  }))
}
