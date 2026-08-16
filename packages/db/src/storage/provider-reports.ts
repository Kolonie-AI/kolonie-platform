import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { AccountKind, ProviderReportOutcome, ProviderReportTally } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountWalks } from '../schema/account-walks.js'

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
 * `0263_one_fact_one_surface`, which marked each with `migrated_at`.
 *
 * **So one function is left, and it does not read this table.** The tally counts
 * the walks. The two moderation accessors that used to serve the converted
 * sentences' second copy are gone with the runner lane behind them (`#1072`):
 * every row is marked and nothing writes a new one, so that queue could only
 * ever match nothing again.
 *
 * `reason`, `reason_status` and `scrubbed_reason` stay on the table. It is the
 * record the conversion is checked against on the day the mapping turns out to
 * have been wrong for one row, and dropping the columns would throw away exactly
 * that.
 */

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
