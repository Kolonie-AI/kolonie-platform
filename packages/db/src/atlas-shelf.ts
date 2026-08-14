import { sql } from 'drizzle-orm'
import { AccountKindSchema, atlasCategoryForKind } from '@kolonie-ai/core'
import type { Database } from './client.js'

/**
 * Every catalogue entry on the shelf its kind names (`#917`).
 *
 * ## What this repairs
 *
 * Until `#807` landed on 2026-08-13, a walk finishing on a provider the
 * catalogue had never heard of wrote its entry with a hardcoded `data-apis`
 * fallback. Measured against production on 2026-08-14, **the four entries
 * waiting for a steward were the whole of the damage** and all four predate that
 * fix: two code hosts, one phone provider and one social provider, every one of
 * them filed under *Data and APIs*.
 *
 * The forward path is closed and this is the material it left behind. It is not
 * a second implementation of the rule: it reads `atlasCategoryForKind`, the same
 * function the walk path, `recordMeasuredProvider` and `measuredOnlyRecipes` all
 * read, so a shelf added later moves the rows here without anybody editing this
 * file.
 *
 * ## Why it matters more than a wrong label usually does
 *
 * A draft is invisible outside the console, so the damage is latent — and
 * **publishing is what makes it public**. A steward reviewing four completed
 * walks has no reason to check the shelf, and the entry that comes out the other
 * side is a real catalogue claim that nobody browsing for a code host can find.
 * Repairing it before the queue is surfaced is the cheap order to do these in.
 *
 * ## What it will not do
 *
 * **It changes the category column and nothing else.** Not the steps, not the
 * status, not the walk that proposed it, not the title a steward may have
 * written. A shelf is the one field here with a single correct value derivable
 * from the row itself, which is exactly why it can be repaired without a
 * judgement — and why nothing beside it can.
 *
 * **A kind with no shelf is left where it is and counted.** `atlasCategoryForKind`
 * throws rather than guessing, and the account-kind vocabulary is open: `trello`
 * is a real entry whose kind names no shelf, and moving it somewhere plausible
 * would be this bug written deliberately. A rising count here is a kind the
 * Colony learned to verify and the Atlas has no shelf for, which is a gap
 * somebody should close.
 *
 * ## Why it is a script and not a `.sql` migration
 *
 * The same reason `atlas-backfill.ts` gives, and it applies harder: the
 * kind-to-shelf map is TypeScript and throws rather than guessing, so a copy of
 * it in SQL would be a second mapping that drifts the first time a shelf is
 * added. Running from the seed also makes it idempotent by construction — the
 * second pass finds every row already agreeing and reports zero moved, which is
 * a different sentence from *this did nothing*.
 */
export interface AtlasShelfRepairResult {
  /** Rows whose category disagreed with their kind and now does not. */
  readonly moved: number
  /** Rows already on the shelf their kind names. The ordinary answer after the first run. */
  readonly agreed: number
  /** Rows whose kind names no shelf, left exactly as they are. */
  readonly unshelved: number
}

/**
 * Move every entry whose category disagrees with its kind onto the right shelf.
 *
 * Safe to run again, and safe to run on a database where nothing is wrong: the
 * answer is `moved: 0` and everything counted as agreeing.
 */
export async function repairAtlasShelves(db: Database): Promise<AtlasShelfRepairResult> {
  const rows = await db.execute<{ id: string; kind: string; category: string }>(sql`
    select id, kind, category from provider_recipes order by kind, provider
  `)

  let moved = 0
  let agreed = 0
  let unshelved = 0

  for (const row of rows) {
    const kind = AccountKindSchema.safeParse(row.kind)

    /**
     * A kind the schema no longer recognises is counted with the unshelved
     * rather than thrown on, on `atlas-backfill.ts`'s argument: this reads
     * historical rows, and a value that was legal when it was written is not a
     * reason to refuse to repair the others.
     */
    if (!kind.success) {
      unshelved += 1
      continue
    }

    let shelf: string
    try {
      shelf = atlasCategoryForKind(kind.data)
    } catch {
      unshelved += 1
      continue
    }

    if (shelf === row.category) {
      agreed += 1
      continue
    }

    /**
     * **`updated_at` is deliberately not touched.** The console orders this
     * queue by how long a draft has been waiting, and stamping the clock here
     * would tell a steward that four walks from two days ago arrived this
     * morning — a repair that hides the age of what it repaired. `#917` asks for
     * the drafts to be *aged*, and this is the one write that could quietly undo
     * that.
     */
    await db.execute(sql`
      update provider_recipes set category = ${shelf} where id = ${row.id}
    `)

    moved += 1
  }

  return { moved, agreed, unshelved }
}
