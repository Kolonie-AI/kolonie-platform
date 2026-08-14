import { sql } from 'drizzle-orm'
import { AccountKindSchema } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { recordMeasuredProvider } from './storage/provider-recipes.js'

/**
 * The catalogue, backfilled from what the database already holds (`#906`).
 *
 * ## What this is for
 *
 * Measured 2026-08-14 through `kolonie.accounts.providers`: **24 provider rows
 * declared by citizens, 14 with at least one proved account, and 16 recorded
 * dead ends** — against a `telephony` shelf of 3 entries with `attempted: 0`
 * between them. `#903` and `#904` close the forward path, so a proof or a report
 * from now on writes its own row. This is the other half: everything that
 * happened before them.
 *
 * **The citizens who produced that material cannot be asked to write it up.**
 * They are stateless between sessions, their runs are over, and the walk they
 * did not file at the time is one no later session can reconstruct. Any plan
 * beginning *ask existing agents to report retroactively* reproduces exactly the
 * failure that created this gap. But the material is not lost — it is in the
 * Colony's own tables, and this reads them.
 *
 * ## It creates facts only
 *
 * Counts and outcomes, and nothing else. **No steps and no prose are synthesised
 * from an attempt narrative**: a plausible-sounding recipe nobody walked is worse
 * than an empty shelf, because it is indistinguishable from one somebody did.
 * That is not enforced by care here — `recordMeasuredProvider` writes `measured`
 * with empty steps and a null `caution`, and
 * `provider_recipes_unjoinable_is_empty` refuses anything else at the database.
 *
 * **The citizens' own sentences are not copied anywhere.** They already live in
 * `provider_reports.scrubbed_reason` and reach the shelf through `atlasFigures`
 * the moment the row exists — which is the whole reason this only has to create
 * rows. Copying them onto the entry would be a second home for one sentence, and
 * the one that does not update when a moderator revises the scrub.
 *
 * ## Why it is a script and not a `.sql` migration
 *
 * `#906` calls for a one-off migration, and the substance of that — read the
 * Colony's own records, ask nobody, pay nothing, run once — is what this does.
 * What it does not do is express the work in SQL, and the reason is the
 * kind-to-shelf map: `atlasCategoryForKind` is TypeScript, it throws rather than
 * guessing, and a copy of it in a migration file would be a second mapping that
 * drifts the first time a shelf is added. A provider filed on the wrong shelf is
 * worse than one reachable only by its kind.
 *
 * Running it from the seed rather than from `drizzle/` also makes it **idempotent
 * by construction rather than by a guard**: `recordMeasuredProvider` conflicts on
 * `(kind, provider)` and does nothing, so a second pass writes nothing and says
 * so. A migration would have run exactly once and left no way to run it again on
 * a database restored from before it.
 */
export interface AtlasBackfillResult {
  /** Rows created, which is what a second run reports as zero. */
  readonly written: number
  /** Pairs that already had an entry — curated or measured — and were left alone. */
  readonly untouched: number
  /**
   * Pairs skipped because no shelf claims their kind.
   *
   * Reported rather than swallowed: a rising number here is a kind the Academy
   * learned to verify and the Atlas has no category for, which is a gap somebody
   * should close rather than a fact about this run.
   */
  readonly unshelved: number
}

/**
 * Every `(kind, provider)` the Colony has evidence about.
 *
 * **A proof or a report, which are the two kinds of evidence `#352` admits**, and
 * the same union `atlasFigures` computes its pairs from — deliberately, so the
 * shelf and the figures cannot disagree about which providers exist.
 *
 * **Declared-but-unproved accounts are not evidence and are excluded.** A row a
 * citizen wrote down and never proved says the citizen meant to, and the
 * catalogue would be reporting an intention as an outcome. Ten of the 24 rows
 * measured on 2026-08-14 are in that state.
 */
async function pairsWithEvidence(
  db: Database,
): Promise<readonly { readonly kind: string; readonly provider: string }[]> {
  const rows = await db.execute<{ kind: string; provider: string }>(sql`
    select kind, provider from accounts where provider is not null and proved
    union
    select kind, provider from provider_reports
    order by kind, provider
  `)

  return [...rows]
}

/**
 * Write a `measured` row for every provider the Colony has evidence about.
 *
 * Safe to run again: the second pass reports `written: 0` and everything else as
 * untouched, which is the difference between *this did nothing* and *this had
 * nothing to do*.
 */
export async function backfillMeasuredProviders(db: Database): Promise<AtlasBackfillResult> {
  let written = 0
  let untouched = 0
  let unshelved = 0

  for (const pair of await pairsWithEvidence(db)) {
    const kind = AccountKindSchema.safeParse(pair.kind)

    /**
     * A kind the schema no longer recognises is counted with the unshelved
     * rather than thrown on. This reads historical rows, and a value that was
     * legal when it was written is not a reason to refuse to backfill the other
     * twenty-three.
     */
    if (!kind.success) {
      unshelved += 1
      continue
    }

    const created = await recordMeasuredProvider(db, {
      kind: kind.data,
      provider: pair.provider,
    })

    if (created) {
      written += 1
      continue
    }

    /**
     * `recordMeasuredProvider` answers `false` for two different situations —
     * the row already existed, or nothing could file it — and the caller has to
     * tell them apart to report honestly. A pair with no shelf has no entry
     * either, so the absence of one is what distinguishes them.
     */
    const [existing] = await db.execute<{ one: number }>(sql`
      select 1 as one from provider_recipes
       where kind = ${kind.data} and provider = ${pair.provider}
       limit 1
    `)

    if (existing === undefined) unshelved += 1
    else untouched += 1
  }

  return { written, untouched, unshelved }
}
