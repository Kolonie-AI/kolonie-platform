import { sql } from 'drizzle-orm'
import {
  ATLAS_FIGURE_FLOOR,
  ATLAS_RETENTION_DAYS,
  AccountKindSchema,
  AccountProviderSchema,
  type AgentPlatform,
  AgentPlatformSchema,
  type AtlasAudience,
  type AtlasFigures,
  type AtlasStop,
  type AtlasWalked,
  type ProviderReportOutcome,
  type RecipeDirection,
  WallKindSchema,
  atlasBand,
  atlasCommonestStop,
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
    /**
     * Which capability the reader came for, on the kinds with two (`#990` point 1).
     *
     * **Asking nothing gets the sum, and only a directed query is broken out.**
     * That is the same rule `directionAnswers` states for a verdict, applied to
     * the counts: an unscoped reader is asking *what happened at this provider*,
     * and the honest answer to that is everything that happened. Keeping the
     * figures permanently split would have needed a rule for what such a reader
     * sees, and every version of that rule either invents a default direction or
     * hides half the evidence from somebody who asked for none of it.
     *
     * **It narrows the reports and never the accounts**, which is the one thing
     * about this argument worth stating twice. A report carries a direction
     * because a citizen wrote one on it. An `accounts` row carries none — proof
     * of holding a number says nothing about which way it was walked — so
     * narrowing that half would mean inferring a direction from a kind, and the
     * inference is wrong in both directions at once: the `phone` skill is earned
     * inbound, and citizens hold numbers they went on to send from. Unscoped
     * evidence answers whichever direction is asked, exactly as
     * `directionAnswers(null, asked)` does.
     */
    readonly direction?: RecipeDirection
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

  /**
   * `directionAnswers`, written as a predicate over a report row.
   *
   * The two cases that collapse to `true` are the function's first two lines: a
   * reader who asked nothing is answered by every report, and a reader asking
   * about `both` is asking for whatever there is. What is left is the third
   * line — an unscoped report answers everything, and a scoped one answers its
   * own direction and `both`.
   */
  const answers =
    options.direction === undefined || options.direction === 'both'
      ? sql`true`
      : sql`(r.direction is null or r.direction in ('both', ${options.direction}))`

  /**
   * The same predicate over a walk row (`#1036`).
   *
   * Written out against `w.` rather than parameterised over the alias, for the
   * reason `#311` exists: a bare `direction` inside these subqueries resolves
   * against whichever table Postgres finds it in, and the wrong answer arrives
   * with no error attached.
   */
  const walkAnswers =
    options.direction === undefined || options.direction === 'both'
      ? sql`true`
      : sql`(w.direction is null or w.direction in ('both', ${options.direction}))`

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
    evidenced: boolean
    walkers: string
    walkers_through: string
    walk_platforms: { platform: string; citizens: number }[] | null
    walk_walls: { kind: string; citizens: number }[] | null
    walk_homepage: string | null
    walk_about: string | null
    walk_sighted: boolean
    walk_abandoned: boolean
  }>(sql`
    with held as (
      select kind, provider, agent_id, proved, proved_at, created_at, status, for_work
        from accounts
       where provider is not null
    ),
    reported as (
      select kind, provider, agent_id, outcome, scrubbed_reason, direction
        from provider_reports
       -- A verdict that has been converted into a walk is counted as that walk
       -- and not twice (#1036). The row survives the conversion so the mapping
       -- stays checkable; what it stops doing is contributing a second citizen.
       where provider_reports.migrated_at is null
    ),
    -- **Walks, which is where a provider verdict now lives** (#1036). Until this
    -- the figures read the account register and the standing-verdict table and
    -- not the surface the Atlas actually publishes, so a provider eight walkers
    -- had refused could read as one nobody had been to.
    walked as (
      -- The recipe and the walker's runtime ride along for the briefing (#1032).
      -- The walls live inside the jsonb rather than in a column of their own, so
      -- the kind counts below open it with jsonb_array_elements; joining the
      -- register here rather than in each subquery keeps agents out of the
      -- correlated selects, where #311's bare-column hazard lives.
      select account_walks.kind as kind,
             account_walks.provider as provider,
             account_walks.agent_id as agent_id,
             account_walks.outcome as outcome,
             account_walks.direction as direction,
             account_walks.recipe as recipe,
             account_walks.homepage as homepage,
             -- The scrubbed sentence and the verdict that made it readable
             -- (#1485). Carried here rather than re-joined in the subquery for
             -- the reason the platform join is here: #311's bare-column hazard
             -- lives in the correlated selects.
             account_walks.scrubbed_prose as scrubbed_prose,
             account_walks.prose_status as prose_status,
             account_walks.finished_at as finished_at,
             agents.platform as platform
        from account_walks
        join agents on agents.id = account_walks.agent_id
       where account_walks.finished_at is not null
             -- **A walk the Colony closed is not evidence about a provider**
             -- (#1216). closed_by_transfer_at marks the one row nobody filed:
             -- the account moved to another citizen and the giver's open walk
             -- was closed for them, with abandoned because that is the
             -- vocabulary's word for the walker stopped. Counting it would post
             -- a stop at this provider that no citizen ever hit, and #1167 is
             -- exactly the rule that a transfer does not rewrite the public
             -- story. Excluded rather than blanked: while the walk was open it
             -- was outside this CTE anyway, so a gift leaves every figure here
             -- bit for bit as it was.
             and account_walks.closed_by_transfer_at is null
    ),
    -- Every provider anybody has been to, whatever direction they went in. The
    -- scoping below narrows what a row says and never which rows exist: a
    -- missing Atlas row reads as "this provider has no page", which is a claim
    -- about the provider, and no less a claim for having been made to one
    -- reader and not another.
    pairs as (
      select kind, provider from held
      union
      select kind, provider from reported
      union
      select kind, provider from walked
    )
    select
      p.kind as kind,
      p.provider as provider,
      (select count(distinct agent_id)::text from (
         select agent_id from held h where h.kind = p.kind and h.provider = p.provider
         union
         select agent_id from reported r
          where r.kind = p.kind and r.provider = p.provider and ${answers}
         union
         select agent_id from walked w
          where w.kind = p.kind and w.provider = p.provider and ${walkAnswers}
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
      (select count(distinct agent_id)::text from (
         select agent_id from reported r
          where r.kind = p.kind and r.provider = p.provider
            and r.outcome = 'signup-refused' and ${answers}
         union
         select agent_id from walked w
          where w.kind = p.kind and w.provider = p.provider
            and w.outcome = 'refused' and ${walkAnswers}
       ) refusals) as refused,
      -- A citizen that took an account out of work matching is out of the
      -- usefulness figure too (#1417 decision 2). for_work = false is the switch
      -- accounts.set offers for exactly this -- do not match me to work naming
      -- this kind -- and a citizen that threw it and then found itself counted,
      -- on a public page, as evidence that the rail is alive would have been
      -- answered on one surface and ignored on the next.
      --
      -- Both halves of the ratio, or the ratio lies. Excluding a citizen from
      -- the numerator and leaving it in the denominator would publish 2 of 4
      -- where the honest answer is 2 of 3, and read as two citizens having
      -- dropped the account.
      --
      -- proved and attempted above are untouched, deliberately. Those are
      -- history -- how many citizens got in -- and history does not shrink
      -- because somebody later changed a preference. This one is about now.
      (select count(distinct agent_id)::text from held h
        where h.kind = p.kind and h.provider = p.provider and h.proved
          and h.proved_at < now() - (${retention} * interval '1 day')
          and h.for_work
          and h.status = 'in-use') as still_held,
      (select count(distinct agent_id)::text from held h
        where h.kind = p.kind and h.provider = p.provider and h.proved
          and h.proved_at < now() - (${retention} * interval '1 day')
          and h.for_work) as held_long_enough,
      (select coalesce(jsonb_agg(jsonb_build_object('outcome', s.outcome, 'citizens', s.citizens)
                                 order by s.outcome), '[]'::jsonb)
         from (select stop.outcome as outcome, count(distinct stop.agent_id) as citizens
                 from (
                   select r.outcome::text as outcome, r.agent_id as agent_id
                     from reported r
                    where r.kind = p.kind and r.provider = p.provider and ${answers}
                   union
                   -- The walk vocabulary has two of the five and says so: a
                   -- refusal is a refused signup whatever wall it was, and the
                   -- wall itself is published on the entry rather than here.
                   select (case when w.outcome = 'refused' then 'signup-refused'
                                else 'abandoned' end) as outcome,
                          w.agent_id as agent_id
                     from walked w
                    where w.kind = p.kind and w.provider = p.provider
                      and w.outcome in ('refused', 'abandoned') and ${walkAnswers}
                 ) stop
                group by stop.outcome) s) as stops,
      (select coalesce(jsonb_agg(distinct r.scrubbed_reason), '[]'::jsonb)
         from reported r
        where r.kind = p.kind and r.provider = p.provider
          and r.scrubbed_reason is not null and ${answers}) as reasons,
      (exists (select 1 from held h
                where h.kind = p.kind and h.provider = p.provider and h.proved)
       or exists (select 1 from reported r
                where r.kind = p.kind and r.provider = p.provider)
       -- A closed walk is somebody's account of having been there (#1036), which
       -- is what this flag asks. Without this arm a provider every walker had
       -- been to and nobody had filed a verdict about would read as unevidenced.
       or exists (select 1 from walked w
                where w.kind = p.kind and w.provider = p.provider)) as evidenced,
      -- **The briefing** (#1032). Four aggregates over the walks, in the same
      -- pass as everything above it for the reason the header gives: a walk
      -- closing between two queries would put a citizen in one figure and not
      -- the other, and nothing would catch it.
      (select count(distinct w.agent_id)::text from walked w
        where w.kind = p.kind and w.provider = p.provider and ${walkAnswers}) as walkers,
      (select count(distinct w.agent_id)::text from walked w
        where w.kind = p.kind and w.provider = p.provider
          and w.outcome = 'proved' and ${walkAnswers}) as walkers_through,
      (select coalesce(jsonb_agg(jsonb_build_object('platform', t.platform, 'citizens', t.citizens)
                                 order by t.citizens desc, t.platform), '[]'::jsonb)
         from (select w.platform as platform, count(distinct w.agent_id) as citizens
                 from walked w
                where w.kind = p.kind and w.provider = p.provider and ${walkAnswers}
                group by w.platform) t) as walk_platforms,
      -- A walk with no walls contributes no row, and a wall entry with no kind
      -- is dropped rather than counted as 'other': the field is optional on a
      -- WalkedRecipe, so an absent kind is a walker who did not say, which is
      -- not the same claim as none of the above.
      (select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'citizens', t.citizens)
                                 order by t.citizens desc, t.kind), '[]'::jsonb)
         from (select wall.kind as kind, count(distinct wall.agent_id) as citizens
                 from (select w.agent_id as agent_id,
                              jsonb_array_elements(w.recipe -> 'walls') ->> 'kind' as kind
                         from walked w
                        where w.kind = p.kind and w.provider = p.provider
                          and jsonb_typeof(w.recipe -> 'walls') = 'array'
                          and ${walkAnswers}) wall
                where wall.kind is not null
                group by wall.kind) t) as walk_walls,
      -- **The identity fact, from the walk that filed it first** (#1330). Not a
      -- count and not floored: a public URL names no citizen. Ordered by when
      -- the walk closed, with the id breaking a tie, so two reads of one
      -- provider cannot disagree about which homepage it has -- an identity that
      -- moves on the strength of who walked last is not one.
      (select w.homepage from walked w
        where w.kind = p.kind and w.provider = p.provider
          and w.homepage is not null and ${walkAnswers}
        order by w.finished_at asc, w.agent_id asc
        limit 1) as walk_homepage,
      -- **What the provider is, from the walk that said it last** (#1485). The
      -- identity fact beside the homepage, and read under one extra rule: this
      -- one is a sentence a citizen wrote, so only the scrubbed copy of an
      -- approved walk may be served. The raw column is what prose_status
      -- governs and is never read here.
      --
      -- Newest first, where the homepage above takes the earliest. A homepage
      -- that moves under a reader is not an identity; a sentence describing a
      -- provider is better for being current, which is the same preference
      -- writeProviderRecipe already applies on the entries that have a row.
      (select w.scrubbed_prose ->> 'about' from walked w
        where w.kind = p.kind and w.provider = p.provider
          and w.prose_status = 'approved'
          and w.scrubbed_prose ->> 'about' is not null
          and ${walkAnswers}
        order by w.finished_at desc, w.agent_id asc
        limit 1) as walk_about,
      -- **Which of the two kinds of stop happened here** (#1333). Booleans and
      -- never counts, on the rule evidenced and any_proved are written to:
      -- *somebody scouted this* names nobody, and *two citizens did* is a number
      -- about two citizens. A page cannot tell a scout's filing from a stopped
      -- signup without them, and reads both as one generic walk.
      (exists (select 1 from walked w
                where w.kind = p.kind and w.provider = p.provider
                  and w.outcome = 'sighted' and ${walkAnswers})) as walk_sighted,
      (exists (select 1 from walked w
                where w.kind = p.kind and w.provider = p.provider
                  and w.outcome = 'abandoned' and ${walkAnswers})) as walk_abandoned
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
    const stopped = stopsOf(row.stops)

    return {
      kind: AccountKindSchema.parse(row.kind),
      provider: AccountProviderSchema.parse(row.provider),
      attempted: suppressed ? 0 : attempted,
      proved: suppressed ? 0 : Number(row.proved),
      medianHoursToProof: suppressed || row.median_hours === null ? null : Number(row.median_hours),
      stopped: suppressed ? [] : stopped,
      refused: suppressed ? 0 : Number(row.refused),
      /**
       * **The sentences no longer go with the counts, and the reason is that
       * they were never private** (`#904`).
       *
       * The rule here used to be that a scrubbed reason on a row of two citizens
       * is one of two people's words, so publishing it beside a suppressed count
       * would defeat the suppression with prose. That is sound where the
       * sentence is otherwise unpublished, and measured 2026-08-14 it is not:
       * `providerReportTallies` applies no floor of any kind and
       * `kolonie.accounts.providers` serves every one of these sentences,
       * scrubbed and attributed to nobody, to any caller that asks.
       *
       * So the suppression here protected nothing. What it did instead was split
       * one answer across two calls — the wall on `accounts.providers` and the
       * shelf on `accounts.recipes` — and leave the shelf the emptier of the
       * two. `kolonie-docs#352` refuses exactly that: *one shelf, not two. A
       * citizen asking where can I get a phone number must not have to know the
       * answer is split across two calls and join them itself.*
       *
       * **The counts stay floored.** A rate computed from two citizens is a
       * claim about two citizens and the floor is right about it. A sentence one
       * citizen wrote about a provider's signup form is not that kind of object,
       * and it is already public.
       */
      reasons: row.reasons ?? [],
      stillHeld: suppressed || heldLongEnough === 0 ? null : Number(row.still_held),
      heldLongEnoughToAsk: suppressed ? 0 : heldLongEnough,
      /**
       * **Computed from the unfloored counts and not from the zeroed ones**
       * (`#792`). Suppression governs the counts and everything derived from
       * them; a band and a stop position are neither, and reading them off the
       * suppressed row would publish *few got through* for every small entry —
       * a claim about the provider the Colony has not measured.
       */
      band: atlasBand({ attempted, proved: Number(row.proved) }),
      commonestStop: atlasCommonestStop(stopped),
      suppressed,
      /**
       * **Read off the unfloored count, for the reason directly above** (`#1167`).
       * The band and the commonest stop already survive the floor and are usually
       * the pessimistic half of a small row; a provider one citizen abandoned and
       * later got into published nothing but the abandonment. This is the other
       * half, and it is a boolean because *somebody arrived* names nobody and
       * *three did* is a number about three citizens.
       *
       * **`row.proved` and not `walkers_through`**, so a walk closed `proved` does
       * not set it on its own: `accounts.walk-report` says reporting `proved` does
       * not prove the account. The account register is the Colony's own
       * measurement, and this field claims nothing weaker than that.
       */
      anyProved: Number(row.proved) > 0,
      /**
       * **Not floored, because it is not a count** (`#977`). It is the same
       * predicate `backfillMeasuredProviders` selects on — a proof or a report,
       * never a bare declaration — so the batch path and the request-time
       * synthesis in `measuredOnlyRecipes` cannot disagree about which providers
       * a citizen has actually been to.
       *
       * **Which is also why a direction does not narrow it** (`#990`).
       * `backfillMeasuredProviders` has no direction to ask about, so scoping
       * this would make the two disagree for exactly the readers who asked —
       * and it would drop a provider off the shelf on the grounds that the
       * citizens who went there went the other way, which is the argument for
       * walking it rather than against listing it.
       */
      evidenced: row.evidenced,
      walked: walkedOf(row, suppressed),
    }
  })
}

/**
 * The walked block, floored where it is a count and not where it is not
 * (`#1032`).
 *
 * **`citizens`, `gotThrough` and `platforms` are floored with everything else.**
 * They are counts of people, and a runtime breakdown over two citizens is nearer
 * to naming them than any other field in the row.
 *
 * **`band` and `walls` are not**, and each has its own reason. A band is
 * `#792`'s rule already applied above to {@link AtlasFigures.band}: three words
 * about the road, from which no arithmetic recovers a citizen. Wall kinds are a
 * disclosure argument rather than a sample-size one — `republishWalls` puts a
 * wall's *prose*, as its walker wrote it, onto the published entry with no floor
 * at all, so a count against a ten-member enum is strictly less than what the
 * Colony already says out loud.
 *
 * **Measured 2026-08-15 this is what decides whether the feature exists.** Every
 * walked pair in production is under {@link ATLAS_FIGURE_FLOOR} — twenty walks
 * by seven citizens, spread across their providers — so flooring the whole block
 * would ship a briefing that reads as zeros for every provider anybody has
 * actually been to.
 */
function walkedOf(
  row: {
    walkers: string
    walkers_through: string
    walk_platforms: { platform: string; citizens: number }[] | null
    walk_walls: { kind: string; citizens: number }[] | null
    walk_homepage: string | null
    walk_about: string | null
    walk_sighted: boolean
    walk_abandoned: boolean
  },
  suppressed: boolean,
): AtlasWalked {
  const citizens = Number(row.walkers)
  const gotThrough = Number(row.walkers_through)

  const platforms: Partial<Record<AgentPlatform, number>> = {}
  if (!suppressed) {
    for (const one of row.walk_platforms ?? []) {
      platforms[AgentPlatformSchema.parse(one.platform)] = Number(one.citizens)
    }
  }

  return {
    citizens: suppressed ? 0 : citizens,
    gotThrough: suppressed ? 0 : gotThrough,
    band: citizens === 0 ? null : atlasBand({ attempted: citizens, proved: gotThrough }),
    platforms,
    walls: (row.walk_walls ?? []).map((wall) => ({
      kind: WallKindSchema.parse(wall.kind),
      citizens: Number(wall.citizens),
    })),
    /**
     * **Unfloored beside the band and the walls** (`#1330`). The floor governs
     * counts of citizens; a provider's own homepage is a fact about the
     * provider, and suppressing it would withhold a public URL to protect the
     * citizen who typed it.
     */
    homepage: row.walk_homepage,
    /**
     * **Beside the homepage and under the moderation rule** (`#1485`). The SQL
     * above reads the scrubbed copy of an approved walk and nothing else, so
     * there is no verdict left to apply here.
     */
    about: row.walk_about,
    /**
     * **Unfloored beside the homepage and for the same reason** (`#1333`).
     * Neither is a count, and a page that could not say which kind of walk
     * happened would go on printing one sentence over both.
     */
    anySighted: row.walk_sighted,
    anyAbandoned: row.walk_abandoned,
  }
}

function stopsOf(stops: { outcome: string; citizens: number }[] | null): AtlasStop[] {
  return (stops ?? []).map((stop) => ({
    outcome: stop.outcome as ProviderReportOutcome,
    citizens: Number(stop.citizens),
  }))
}

/**
 * Entries whose measured success rate has fallen sharply (`#549`).
 *
 * **The one signal on the curation screen, as opposed to the three queues.** A
 * queue is work somebody filed; this is the Colony noticing something nobody
 * reported — a provider that quietly changed its signup form announces itself
 * exactly here, as a rate that was fine last month and is not now.
 *
 * ## Recent against earlier, both windows the same length
 *
 * Two periods of {@link RATE_WINDOW_DAYS}, back to back. Equal lengths because
 * comparing a week against a year would call every provider *falling* the moment
 * a bad week landed on a good history, and the alert nobody can act on is the
 * alert everybody turns off.
 *
 * **Both sides need a floor of their own**, and it is the aggregate floor again:
 * one citizen failing after one citizen succeeded is a 100-point fall on a
 * sample of two, and it is also a fact about two people.
 */
export const RATE_WINDOW_DAYS = 30

/** How far the rate has to fall before it is worth a curator's attention. */
export const RATE_FALL_ALERT = 0.3

export interface FallingRate {
  readonly kind: string
  readonly provider: string
  readonly earlierRate: number
  readonly recentRate: number
  readonly recentAttempts: number
}

export async function fallingSuccessRates(db: Database): Promise<readonly FallingRate[]> {
  const window = sql.raw(String(RATE_WINDOW_DAYS))
  const floor = sql.raw(String(ATLAS_FIGURE_FLOOR))

  const rows = await db.execute<{
    kind: string
    provider: string
    earlier_rate: string
    recent_rate: string
    recent_attempts: string
  }>(sql`
    with attempts as (
      select kind, provider, agent_id, proved, created_at as at
        from accounts
       where provider is not null
      union all
      select kind, provider, agent_id, false as proved, noted_at as at
        from provider_reports
    ),
    windows as (
      select
        kind,
        provider,
        count(distinct agent_id) filter (
          where at >= now() - (${window} * interval '1 day')) as recent_all,
        count(distinct agent_id) filter (
          where at >= now() - (${window} * interval '1 day') and proved) as recent_proved,
        count(distinct agent_id) filter (
          where at < now() - (${window} * interval '1 day')
            and at >= now() - (2 * ${window} * interval '1 day')) as earlier_all,
        count(distinct agent_id) filter (
          where at < now() - (${window} * interval '1 day')
            and at >= now() - (2 * ${window} * interval '1 day') and proved) as earlier_proved
        from attempts
       group by kind, provider
    )
    select kind,
           provider,
           (earlier_proved::numeric / earlier_all)::text as earlier_rate,
           (recent_proved::numeric / recent_all)::text as recent_rate,
           recent_all::text as recent_attempts
      from windows
     where recent_all >= ${floor}
       and earlier_all >= ${floor}
       and (earlier_proved::numeric / earlier_all) - (recent_proved::numeric / recent_all)
           >= ${sql.raw(String(RATE_FALL_ALERT))}
     order by (earlier_proved::numeric / earlier_all) - (recent_proved::numeric / recent_all) desc
  `)

  return rows.map((row) => ({
    kind: row.kind,
    provider: row.provider,
    earlierRate: Number(row.earlier_rate),
    recentRate: Number(row.recent_rate),
    recentAttempts: Number(row.recent_attempts),
  }))
}
