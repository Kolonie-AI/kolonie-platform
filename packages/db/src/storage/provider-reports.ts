import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type {
  AccountKind,
  AgentId,
  ProviderReportOutcome,
  ProviderReportTally,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountWalks } from '../schema/account-walks.js'
import { providerReports } from '../schema/provider-reports.js'

/**
 * Reports about providers that produced no account (`#298`).
 *
 * The register's mirror image: `accounts.ts` counts what citizens got, this
 * counts what they did not.
 *
 * **`provider_reports` is a frozen historical record and has no writer**
 * (`#1036`). The verdict a citizen files through the retiring
 * `kolonie.accounts.provider-report` alias is a walk, written by `finishWalk`;
 * the rows already here were converted into exactly such walks by
 * `0263_one_fact_one_surface`, which marked each with `migrated_at`. What is
 * left in this file reads: the tally, which now counts the walks, and the two
 * moderation accessors, which serve the converted sentences' second copy and
 * are therefore permanently empty. Removing them and the runner lane behind
 * them is `#1072`.
 */

/** One reason the moderator has not read yet. */
export interface UnmoderatedProviderReason {
  readonly agentId: AgentId
  readonly kind: string
  readonly provider: string
  readonly reason: string
}

/**
 * The reasons waiting on the scrub, oldest first.
 *
 * Keyed by the row's own primary key rather than by a surrogate id, because
 * `provider_reports` has none — and a verdict that arrives after the citizen
 * rewrote its report must not land on the new text, which is what the `reason`
 * comparison in {@link recordProviderReasonModeration} is for.
 *
 * **A migrated row is never queued, so this queue drains to empty and stays
 * there** (`#1036`). The conversion carried each pending sentence onto the walk
 * it wrote, where the walk-prose lane judges it; leaving the row queued here as
 * well would have the same sentence read twice and scrubbed into two columns,
 * which is the double record this issue removes. Since the migration marks every
 * row and nothing writes a new one, `migrated_at is null` matches nothing from
 * here on — that is the intended end state and not a bug to be found later.
 */
export async function unmoderatedProviderReasons(
  db: Database,
  limit: number,
): Promise<readonly UnmoderatedProviderReason[]> {
  const rows = await db
    .select({
      agentId: providerReports.agentId,
      kind: providerReports.kind,
      provider: providerReports.provider,
      reason: providerReports.reason,
    })
    .from(providerReports)
    .where(
      and(
        eq(providerReports.reasonStatus, 'pending'),
        isNotNull(providerReports.reason),
        isNull(providerReports.migratedAt),
      ),
    )
    .orderBy(asc(providerReports.notedAt))
    .limit(limit)

  return rows.map((row) => ({
    agentId: row.agentId as AgentId,
    kind: row.kind,
    provider: row.provider,
    reason: row.reason as string,
  }))
}

/**
 * Write what the scrub produced, or refuse the reason.
 *
 * **The text the moderator read is part of the key.** A citizen may rewrite its
 * report while the pass is thinking, and a verdict applied to whatever is in the
 * column now would publish text nothing judged. The row simply stays `pending`
 * and the next poll picks up what is actually there — the same guard
 * `recordModeration` uses on a report, for the same reason.
 */
export async function recordProviderReasonModeration(
  db: Database,
  command: {
    readonly agentId: AgentId
    readonly kind: string
    readonly provider: string
    /** What the moderator was shown. The verdict is refused if it has changed. */
    readonly judged: string
    readonly decision: 'approved' | 'rejected'
    readonly scrubbed?: string
  },
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  const written = await db
    .update(providerReports)
    .set({
      reasonStatus: command.decision,
      // A refused reason keeps its row and gains no scrub: the citizen wrote it,
      // the Colony declined to pass it on, and the outcome it filed still counts.
      scrubbedReason: command.decision === 'approved' ? (command.scrubbed ?? null) : null,
    })
    .where(
      and(
        eq(providerReports.agentId, command.agentId),
        eq(providerReports.kind, command.kind),
        eq(providerReports.provider, command.provider),
        eq(providerReports.reasonStatus, 'pending'),
        eq(providerReports.reason, command.judged),
      ),
    )
    .returning({ provider: providerReports.provider })

  return { outcome: written[0] === undefined ? 'stale' : 'written' }
}

/**
 * What the Colony can say out loud about providers that produced nothing.
 *
 * **Read off the walk now, not off this table** (`#1036`). The verdict a citizen
 * files through `provider-report` is a walk, so this counts closed walks that
 * stopped — and the rows already in `provider_reports` are counted here because
 * the migration converted every one of them into exactly such a walk. Counting
 * both would count the converted citizen twice, which is the double record the
 * issue exists to remove.
 *
 * **The vocabulary is the walk's, projected back into this one.** A walk knows
 * *refused* and *abandoned*; which of the five a refusal was is not on the row
 * and is not recoverable, because the mapping collapsed four into one. So a
 * refusal answers as `signup-refused` — the same projection `atlasFigures`
 * makes — and where the citizen was actually stopped is in the sentence beside
 * the count, which was always the more useful half.
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
  const experienced = sql<string>`count(distinct account_walks.agent_id) filter (
    where exists (
      select 1 from accounts a
       where a.agent_id = account_walks.agent_id
         and a.kind = account_walks.kind
         and a.proved = true
    )
  )`

  /**
   * The projection, written once and grouped on (`#1036`).
   *
   * `group by` repeats the expression rather than referring to the select alias,
   * because an alias is not in scope there in Postgres and an ordinal would put
   * the meaning of this group in a number.
   */
  const projected = sql<ProviderReportOutcome>`case when ${accountWalks.outcome} = 'refused'
                                                    then 'signup-refused' else 'abandoned' end`

  const rows = await db
    .select({
      kind: accountWalks.kind,
      provider: accountWalks.provider,
      outcome: projected,
      citizens: sql<string>`count(distinct ${accountWalks.agentId})`,
      experienced,
      /**
       * The moderated sentences, and only those (`#362`).
       *
       * `scrubbed_reason` and never `reason`, which is the structural half of
       * *counted, never listed*: there is no path from an unread sentence to a
       * reader, rather than a `where` clause each surface has to remember.
       *
       * `filter (where … is not null)` rather than a `where` on the query,
       * because a provider whose reasons are all still pending must keep its
       * counts — the count is the primary signal and the sentences are beside
       * it. Deduplicated, so twenty citizens that pasted the same wall are one
       * line and the number above it is what says twenty.
       */
      reasons: sql<
        string[]
      >`coalesce(array_agg(distinct ${accountWalks.scrubbedProse}->>'wall') filter (where ${accountWalks.scrubbedProse}->>'wall' is not null), '{}')`,
    })
    .from(accountWalks)
    .where(
      and(
        isNotNull(accountWalks.finishedAt),
        inArray(accountWalks.outcome, ['refused', 'abandoned']),
        kind === undefined ? undefined : eq(accountWalks.kind, kind),
      ),
    )
    .groupBy(accountWalks.kind, accountWalks.provider, projected)
    .orderBy(
      desc(sql`count(distinct ${accountWalks.agentId})`),
      desc(experienced),
      asc(accountWalks.provider),
    )

  return rows.map((row) => ({
    kind: row.kind as ProviderReportTally['kind'],
    provider: row.provider as ProviderReportTally['provider'],
    outcome: row.outcome as ProviderReportOutcome,
    citizens: Number(row.citizens),
    experienced: Number(row.experienced),
    reasons: row.reasons,
  }))
}
