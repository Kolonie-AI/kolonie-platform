import { sql } from 'drizzle-orm'
import { ATLAS_KIND_ALIASES } from '@kolonie-ai/core'
import type { Database } from './client.js'

/**
 * One provider, one row per account kind (`#1144`).
 *
 * ## What this repairs
 *
 * Measured against production on 2026-08-17, **three of the Atlas' 166 rows
 * were a second spelling of a kind the same provider already had a row for**.
 * `codeberg.org` carried a curated `code-host` row nobody had written beside a
 * walked `code-hosting` row with three walls, a six-claim briefing and a full
 * route; `todoist.com` had `todoist` beside `project-tracker`, and
 * `bitwarden.com` `identity-security` beside `identity`.
 *
 * The cost is not the extra line on the index. `atlasEntryOperatorNeed` takes
 * the strictest row and the entry's sentence comes from the lead row, so the
 * empty twin decided both — a citizen's afternoon at Codeberg sat underneath
 * *nobody has walked this*, on the page that exists to say otherwise.
 *
 * The forward path is closed: `walkInProgress`, `recordMeasuredProvider` and
 * the episode close each resolve the kind through `atlasCanonicalKind` before
 * it becomes a catalogue key, the way they already resolve a provider's name
 * through `canonicalProvider`. This is the material they left behind.
 *
 * ## What it moves and what it refuses to
 *
 * **A row with findings is never dropped.** Where the two rows collide, the
 * empty one goes and the walked one takes the canonical kind; where *both*
 * carry findings the pair is left exactly as it is and counted as
 * `conflicted`, because merging two written-up rows is a judgement about which
 * account of a provider is true and nothing here is entitled to make it.
 *
 * **The walker's own word is kept**, in `account_walks.kind_as_given`. `#1096`
 * decided that a kind nobody anticipated is a finding rather than a mistake,
 * and a repair that silently rewrote what a citizen typed would be that
 * decision reversed by a migration.
 *
 * **`agent_accounts` is not touched.** A row there is a citizen's own register:
 * its kind carries the per-agent uniqueness and the `preferred` choice, so
 * moving it could merge two rows a citizen wrote itself. The Atlas collision is
 * a catalogue problem and is fixed where the catalogue is; a figure still
 * counted under an alias reaches the canonical row through
 * `measuredOnlyRecipes`, which asks the pair under the kind it means.
 *
 * **`updated_at` is left alone**, on `repairAtlasShelves`' argument one file
 * over: the steward console orders by how long a row has been waiting, and
 * stamping the clock here would tell a steward that a walk from last week
 * arrived this morning.
 *
 * ## Why it is a script and not a `.sql` migration
 *
 * The same reason `atlas-shelf.ts` and `atlas-backfill.ts` give, and the issue
 * asked for a migration before this file existed. The alias table is
 * TypeScript, it is guarded at module load, and a copy of it in SQL would be a
 * second list that drifts the first time a fourth spelling is measured. Running
 * from the seed also makes it idempotent by construction: the second pass finds
 * nothing under any alias and reports zeroes, which is a different sentence
 * from *this did nothing*.
 */
export interface AtlasKindReconcileResult {
  /** Catalogue rows moved onto the kind their spelling means. */
  readonly moved: number
  /** Empty twins dropped so the walked row could take the kind. */
  readonly dropped: number
  /** Walks re-keyed, each keeping the word its walker typed. */
  readonly walks: number
  /** Provider verdicts re-keyed. */
  readonly reports: number
  /** Briefings moved or dropped; every one of them left stale, to be written from the merged walks. */
  readonly briefings: number
  /** Pairs where both rows carry findings, left exactly as they are. */
  readonly conflicted: number
}

/**
 * Whether a catalogue row says anything a reader would lose.
 *
 * **Asked of the columns a walk writes**, not of the status alone. An
 * `unwritten` row carrying a refusal is a finding — that is what a converted
 * provider verdict looks like — and a `measured` row with steps on it is a route
 * somebody wrote. The empty twin this drops is the one that answers no to every
 * clause.
 */
function hasFindings(table: string) {
  return sql`(
    ${sql.raw(table)}.status not in ('unwritten', 'measured')
    or ${sql.raw(table)}.refusal is not null
    or ${sql.raw(table)}.about is not null
    or ${sql.raw(table)}.description is not null
    or jsonb_array_length(${sql.raw(table)}.steps) > 0
    or jsonb_array_length(${sql.raw(table)}.cautions) > 0
    or jsonb_array_length(${sql.raw(table)}.walls) > 0
    or ${sql.raw(table)}.walked_recipe is not null
  )`
}

/**
 * Fold every alias spelling onto the kind it means.
 *
 * Safe to run again, and safe on a database where nothing is wrong: every count
 * comes back zero.
 */
export async function reconcileAtlasKinds(db: Database): Promise<AtlasKindReconcileResult> {
  let moved = 0
  let dropped = 0
  let walks = 0
  let reports = 0
  let briefings = 0
  let conflicted = 0

  for (const [alias, canonical] of Object.entries(ATLAS_KIND_ALIASES)) {
    /**
     * **The catalogue first**, because the counts below are read against the
     * row that survives. A pair left `conflicted` here keeps both its rows, and
     * its walks are still re-keyed: a walk belongs to a kind, not to a row, and
     * the two rows are a question for a steward rather than a reason to leave
     * the evidence spelled two ways.
     */
    const pairs = await db.execute<{
      aliasId: string
      canonicalId: string | null
      aliasHasFindings: boolean
      canonicalHasFindings: boolean | null
    }>(sql`
      select
        a.id as "aliasId",
        c.id as "canonicalId",
        ${hasFindings('a')} as "aliasHasFindings",
        case when c.id is null then null else ${hasFindings('c')} end as "canonicalHasFindings"
      from provider_recipes as a
      left join provider_recipes as c
        on c.kind = ${canonical} and c.provider = a.provider
      where a.kind = ${alias}
      order by a.provider
    `)

    for (const pair of pairs) {
      if (pair.canonicalId === null) {
        await db.execute(sql`
          update provider_recipes set kind = ${canonical} where id = ${pair.aliasId}
        `)
        moved += 1
        continue
      }

      if (pair.aliasHasFindings && pair.canonicalHasFindings === true) {
        conflicted += 1
        continue
      }

      /**
       * The empty one goes. Where neither says anything the canonical row is
       * the one kept, because it is the spelling the seed curates and the one
       * every surface will write from here on.
       */
      if (pair.aliasHasFindings) {
        await db.execute(sql`delete from provider_recipes where id = ${pair.canonicalId}`)
        await db.execute(sql`
          update provider_recipes set kind = ${canonical} where id = ${pair.aliasId}
        `)
        moved += 1
      } else {
        await db.execute(sql`delete from provider_recipes where id = ${pair.aliasId}`)
      }

      dropped += 1
    }

    /**
     * **Walks, keeping the word that was typed.** `coalesce` rather than a
     * plain assignment so a row this pass has already seen keeps the original
     * spelling rather than being overwritten with the canonical one on a second
     * run — the case that makes an idempotent script and a destructive one look
     * identical until it has run twice.
     *
     * The `not exists` guard is `account_walks_rewarded_provider_unique`: one
     * citizen is paid once per provider, and a citizen that was paid under both
     * spellings would abort the whole statement on the index. Those rows are
     * left where they are and counted with the conflicts — a payment is the one
     * thing here that cannot be reconstructed.
     */
    const movedWalks = await db.execute<{ id: string }>(sql`
      update account_walks as w
      set kind_as_given = coalesce(w.kind_as_given, w.kind), kind = ${canonical}
      where w.kind = ${alias}
        and not exists (
          select 1 from account_walks as other
          where other.agent_id = w.agent_id
            and other.kind = ${canonical}
            and other.provider = w.provider
            and other.rewarded_at is not null
            and w.rewarded_at is not null
        )
      returning w.id
    `)
    walks += movedWalks.length

    const movedReports = await db.execute<{ agentId: string }>(sql`
      update provider_reports as r
      set kind = ${canonical}
      where r.kind = ${alias}
        and not exists (
          select 1 from provider_reports as other
          where other.agent_id = r.agent_id
            and other.kind = ${canonical}
            and other.provider = r.provider
        )
      returning r.agent_id as "agentId"
    `)
    reports += movedReports.length

    /**
     * **Briefings are re-keyed and then left stale**, never carried across as
     * current. A briefing is composed from the walks at a pair, and this pass
     * has just changed which walks those are — so the alias' briefing is moved
     * where the canonical pair has none, dropped where it has one, and either
     * way the survivor is marked for rewriting. `renameProvider` makes the same
     * call one file over and for the same reason.
     */
    const droppedBriefings = await db.execute<{ provider: string }>(sql`
      delete from provider_briefings as b
      where b.kind = ${alias}
        and exists (
          select 1 from provider_briefings as c
          where c.kind = ${canonical} and c.provider = b.provider
        )
      returning b.provider
    `)

    const rekeyed = await db.execute<{ provider: string }>(sql`
      update provider_briefings set kind = ${canonical} where kind = ${alias}
      returning provider
    `)

    const touched = [...new Set([...droppedBriefings, ...rekeyed].map((row) => row.provider))]

    for (const provider of touched) {
      await db.execute(sql`
        update provider_briefings
        set dirty = true
        where kind = ${canonical} and provider = ${provider}
      `)
    }

    briefings += droppedBriefings.length + rekeyed.length
  }

  return { moved, dropped, walks, reports, briefings, conflicted }
}
