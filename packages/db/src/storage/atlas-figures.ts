import { sql } from 'drizzle-orm'
import {
  ATLAS_FIGURE_FLOOR,
  ATLAS_RETENTION_DAYS,
  AccountKindSchema,
  AccountProviderSchema,
  type AtlasAudience,
  type AtlasFigures,
  type AtlasStop,
  type ProviderReportOutcome,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'

/**
 * What the Colony measured about every recipe in the catalogue (`#545`).
 *
 * **Computed, never stored.** There is no figures table and no rank column, so
 * there is nothing for a paying provider to have edited — which is `#543` rule 2
 * enforced by the absence of a thing rather than by a policy somebody has to
 * apply. `#548` requires that no orderable field ever exists; this is why one is
 * never needed.
 *
 * ## The raw material is what already exists
 *
 * `accounts` says who ended up holding something and when it was proved;
 * `provider_reports` says who said they did not get one and where it stopped
 * them. Nothing new is written and no second reporting path is opened — `#545`
 * is explicit that `kolonie.accounts.provider-report` is the raw material.
 *
 * ## Why one query and not five
 *
 * Five aggregates over two tables, joined on `(kind, provider)`, computed in one
 * pass. Five queries would each pay for the same scans, and — worse — could
 * disagree: a report filed between two of them would put a citizen in
 * `attempted` and not in `stopped`, and the published rate would be wrong in a
 * way nothing would catch.
 *
 * ## What is not in a row
 *
 * **No agent id, no identifier, no unmoderated text.** Every count is
 * `count(distinct agent_id)` and no id is selected; the sentences come from
 * `scrubbed_reason` and never from `reason`, which is the same rule
 * `ProviderReportTallySchema` follows and for the same reason.
 */
export async function atlasFigures(
  db: Database,
  options: {
    /**
     * Who is reading.
     *
     * `public` applies the floor. `provider` lifts it — that is what `#548`'s
     * claim buys, a provider seeing its own numbers in full, which is what it is
     * paying for. **The lift is granted by naming a provider and never by the
     * flag alone**: `provider` with nothing named is treated as public, so the
     * unfloored whole catalogue is not one word away.
     */
    readonly audience?: AtlasAudience
    /** The single provider a `provider` audience is entitled to. Ignored when public. */
    readonly provider?: string
  } = {},
): Promise<readonly AtlasFigures[]> {
  const audience = options.audience ?? 'public'

  /**
   * **A `provider` audience must name its provider, and it gets that one only.**
   * Without this a caller could ask for the unfloored whole catalogue by passing
   * one word — the escape hatch every audience flag grows if nothing closes it.
   */
  const entitled =
    audience === 'provider' && options.provider !== undefined
      ? AccountProviderSchema.parse(options.provider)
      : undefined

  const retention = sql.raw(String(ATLAS_RETENTION_DAYS))
  const only = entitled === undefined ? sql`true` : sql`p.provider = ${entitled}`

  const rows = await db.execute<{
    kind: string
    provider: string
    attempted: string
    proved: string
    median_hours: string | null
    refused: string
    still_held: string | null
    held_long_enough: string
    stops: { outcome: string; citizens: number }[] | null
    reasons: string[] | null
  }>(sql`
    with held as (
      select kind, provider, agent_id, proved, proved_at, created_at, status
        from accounts
       where provider is not null
    ),
    reported as (
      select kind, provider, agent_id, outcome, scrubbed_reason
        from provider_reports
    ),
    pairs as (
      select kind, provider from held
      union
      select kind, provider from reported
    )
    select
      p.kind as kind,
      p.provider as provider,
      (select count(distinct agent_id)::text from (
         select agent_id from held h where h.kind = p.kind and h.provider = p.provider
         union
         select agent_id from reported r where r.kind = p.kind and r.provider = p.provider
       ) tried) as attempted,
      (select count(distinct agent_id)::text from held h
        where h.kind = p.kind and h.provider = p.provider and h.proved) as proved,
      (select round(
                percentile_cont(0.5) within group (
                  order by extract(epoch from (h.proved_at - h.created_at)) / 3600
                )::numeric, 1)::text
         from held h
        where h.kind = p.kind and h.provider = p.provider and h.proved
          and h.proved_at is not null) as median_hours,
      (select count(distinct agent_id)::text from reported r
        where r.kind = p.kind and r.provider = p.provider
          and r.outcome = 'signup-refused') as refused,
      (select count(distinct agent_id)::text from held h
        where h.kind = p.kind and h.provider = p.provider and h.proved
          and h.proved_at < now() - (${retention} * interval '1 day')
          and h.status = 'in-use') as still_held,
      (select count(distinct agent_id)::text from held h
        where h.kind = p.kind and h.provider = p.provider and h.proved
          and h.proved_at < now() - (${retention} * interval '1 day')) as held_long_enough,
      (select coalesce(jsonb_agg(jsonb_build_object('outcome', s.outcome, 'citizens', s.citizens)
                                 order by s.outcome), '[]'::jsonb)
         from (select r.outcome as outcome, count(distinct r.agent_id) as citizens
                 from reported r
                where r.kind = p.kind and r.provider = p.provider
                group by r.outcome) s) as stops,
      (select coalesce(jsonb_agg(distinct r.scrubbed_reason), '[]'::jsonb)
         from reported r
        where r.kind = p.kind and r.provider = p.provider
          and r.scrubbed_reason is not null) as reasons
      from pairs p
     where ${only}
     order by p.kind, p.provider
  `)

  return rows.map((row) => {
    const attempted = Number(row.attempted)
    /**
     * **The floor is applied here and the row is still returned**, rather than
     * dropped as `permissionBlockCounts` drops one. The difference is what the
     * absence would say: a missing permission row is a fact nobody was looking
     * for, and a missing Atlas row is *this provider has no page*, which is a
     * claim about the provider. So the entry stays, the counts go to zero, and
     * `suppressed` says which of the two silences this is.
     */
    const suppressed = entitled === undefined && attempted > 0 && attempted < ATLAS_FIGURE_FLOOR

    const heldLongEnough = Number(row.held_long_enough)

    return {
      kind: AccountKindSchema.parse(row.kind),
      provider: AccountProviderSchema.parse(row.provider),
      attempted: suppressed ? 0 : attempted,
      proved: suppressed ? 0 : Number(row.proved),
      medianHoursToProof: suppressed || row.median_hours === null ? null : Number(row.median_hours),
      stopped: suppressed ? [] : stopsOf(row.stops),
      refused: suppressed ? 0 : Number(row.refused),
      /**
       * **The sentences go with the counts.** A scrubbed reason on a row of two
       * citizens is one of two people's words, and publishing it beside a
       * suppressed count would defeat the suppression with prose.
       */
      reasons: suppressed ? [] : (row.reasons ?? []),
      stillHeld: suppressed || heldLongEnough === 0 ? null : Number(row.still_held),
      heldLongEnoughToAsk: suppressed ? 0 : heldLongEnough,
      suppressed,
    }
  })
}

function stopsOf(stops: { outcome: string; citizens: number }[] | null): AtlasStop[] {
  return (stops ?? []).map((stop) => ({
    outcome: stop.outcome as ProviderReportOutcome,
    citizens: Number(stop.citizens),
  }))
}
