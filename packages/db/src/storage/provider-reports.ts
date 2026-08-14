import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'
import type {
  AccountKind,
  AgentId,
  ProviderReportOutcome,
  ProviderReportTally,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { providerReports } from '../schema/provider-reports.js'
import { markProviderRecipeStale, recordMeasuredProvider } from './provider-recipes.js'

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
    /**
     * The sentence beside the outcome (`#362`), or absent.
     *
     * Absent on a rewrite **clears** the previous one rather than keeping it.
     * The alternative — keep what was there unless a new one arrives — would
     * leave a citizen's explanation of one verdict standing beside a different
     * verdict, which is the one way this column can say something nobody wrote.
     */
    readonly reason?: string
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

  /**
   * A new reason is unmoderated by construction, and a row without one is not
   * waiting for anything — which is what keeps the pass's queue equal to
   * *reasons nobody has read*. The scrub is always cleared here: a sentence
   * approved against the old text must never survive onto new text.
   */
  const reason = input.reason ?? null
  const written = {
    outcome: input.outcome,
    reason,
    scrubbedReason: null,
    reasonStatus: (reason === null ? 'approved' : 'pending') as 'approved' | 'pending',
    notedAt: new Date().toISOString(),
  }

  await db
    .insert(providerReports)
    .values({ agentId, kind: input.kind, provider: input.provider, ...written })
    .onConflictDoUpdate({
      target: [providerReports.agentId, providerReports.kind, providerReports.provider],
      set: written,
    })

  /**
   * **A report against a provider with an entry marks that entry stale**
   * (`#525`).
   *
   * Here rather than in a second reporting path, which is the whole of `#525`'s
   * *following an entry and failing is reportable*: the report an agent already
   * files is the report. A citizen that walked a published recipe and did not
   * get through is the strongest available evidence that the recipe has gone
   * out of date, and the catalogue has to stop presenting it as current.
   *
   * It clears the confirmation rather than setting a flag, so `isStale` reads
   * it exactly as it reads *never confirmed* — a reader can act on neither.
   */
  await markProviderRecipeStale(db, input.kind, input.provider)

  /**
   * **A report against a provider with no entry gives it one** (`#904`).
   *
   * This is the gap the issue is named for, and it is narrow: refusals were
   * never categorically shut out of the catalogue — `walkVerdict` publishes a
   * walk reported as `refused` with a wall named. But that route runs through
   * `walk-report`, and the channel agents actually reach for is this one.
   * Sixteen rows here against nothing on the telephony shelf, measured
   * 2026-08-14, is the measurement of which one gets used.
   *
   * **It creates a row and never a verdict.** `recordMeasuredProvider` writes
   * `measured` with no steps, no refusal and no caution, so a report cannot
   * mark a provider closed — that stays a walk's finding with a wall named. All
   * this does is give the citizen's own sentence somewhere to be read.
   *
   * `onConflictDoNothing` inside means a provider that already has an entry,
   * curated or measured, is untouched.
   */
  await recordMeasuredProvider(db, { kind: input.kind, provider: input.provider })

  return { outcome: 'recorded' }
}

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
    .where(and(eq(providerReports.reasonStatus, 'pending'), isNotNull(providerReports.reason)))
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
      >`coalesce(array_agg(distinct ${providerReports.scrubbedReason}) filter (where ${providerReports.scrubbedReason} is not null), '{}')`,
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
    reasons: row.reasons,
  }))
}
