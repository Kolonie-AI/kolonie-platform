import { seedAcademyTasks } from './academy-tasks.js'
import { seedProviderCatalogue } from './provider-catalogue.js'
import { curateListedAtlasEntries, seedListedAtlasEntries } from './atlas-providers.js'
import { seedBundles } from './storage/provider-bundles.js'
import { backfillMeasuredProviders } from './atlas-backfill.js'
import { scopeTelephonyDirections } from './atlas-directions.js'
import { reconcileAtlasKinds } from './atlas-kinds.js'
import { repairAtlasShelves } from './atlas-shelf.js'
import { createDatabase, databaseUrlFromEnv } from './client.js'

/**
 * Put the Academy tasks in the database, then exit.
 *
 * A separate process from `migrate`, and run after it, for the reason
 * `migrate.ts` is separate from the API: a step that does one thing can be run
 * again on its own when it is the thing that failed. It is safe to re-run — see
 * `seedAcademyTasks` for why that is a property of the data rather than a check
 * around it.
 *
 * It reports what it changed. `GET /v1/tasks` returning an empty list is the
 * failure this whole script exists to prevent, and a deploy log that prints the
 * same line whether it seeded three tasks or none cannot tell anyone whether it
 * was prevented — the same argument as kolonie-infra#9.
 */
async function main(): Promise<void> {
  const db = createDatabase(databaseUrlFromEnv(), { max: 1, onnotice: () => {} })
  try {
    const { inserted, updated, hints, landscape } = await seedAcademyTasks(db)
    console.log(
      `academy tasks: ${inserted} inserted, ${updated} already present and refreshed, ` +
        // Both totals, and the second is the one worth watching (#390): hints
        // are served to a citizen that asked, landscape notes to every citizen
        // on every attempt. One number is an opt-in cost and the other is not.
        `${hints} hints and ${landscape} landscape notes serving`,
    )

    /**
     * The provider catalogue (`#521`), seeded from the same script and after the
     * tasks: an entry may name a rung, and a catalogue that pointed at a task the
     * database did not have would be a walk ending nowhere.
     */
    const { written } = await seedProviderCatalogue(db)
    console.log(`provider catalogue: ${written} entries written`)

    /**
     * The bundles (`#531`), after the catalogue for the same reason the
     * catalogue comes after the tasks: a bundle names entries, and one seeded
     * before them would be a recommendation pointing at nothing.
     *
     * **It is not an error for a bundle to name an entry that does not exist**
     * — the read says so and the operator sees it — so this ordering is about
     * the ordinary case rather than about correctness.
     */
    /**
     * The providers the Atlas merely lists (`#590`), after the recipes above and
     * before the bundles.
     *
     * **After the recipes** because it never overwrites one and the ordering
     * makes that visible rather than merely true: the three walked entries are
     * in place when the listing runs, so its conflicts are the ones it is meant
     * to have. **Before the bundles** for the reason the catalogue is: a bundle
     * naming a provider the catalogue has never heard of shows the operator a
     * gap that is really an ordering.
     */
    const { listed, untouched } = await seedListedAtlasEntries(db)
    console.log(
      `atlas providers: ${listed} newly listed, ${untouched} already in the catalogue and ` +
        'left untouched',
    )

    /**
     * The eighteen nobody can walk (`#679`), immediately after the listing that
     * puts them on their shelves — a curation pass that ran before them would
     * have nothing to answer on a fresh database.
     */
    const { refused, retired, leftToTheirWalks } = await curateListedAtlasEntries(db)
    console.log(
      `atlas curation: ${refused} refused with a named wall, ${retired} withdrawn as not ` +
        `accounts, ${leftToTheirWalks} left to the walk that has since answered them`,
    )

    /**
     * The catalogue caught up with the register (`#906`), after the listing and
     * the curation above.
     *
     * **After them, because it never overwrites an entry and the ordering makes
     * that visible rather than merely true.** Every curated row is in place when
     * this runs, so the pairs it leaves untouched are the ones it is meant to
     * leave untouched, and the number it reports as written is the number of
     * providers the catalogue genuinely did not know about.
     *
     * It is safe on every deploy and reports zero once it has run, which is why
     * it lives here rather than in `drizzle/`.
     */
    const {
      written: measured,
      untouched: alreadyShelved,
      unshelved,
    } = await backfillMeasuredProviders(db)
    console.log(
      `atlas backfill: ${measured} providers the Colony has evidence about newly on a shelf, ` +
        `${alreadyShelved} already in the catalogue and left untouched, ` +
        `${unshelved} skipped for want of a shelf`,
    )

    /**
     * The telephony verdicts, scoped to the capability they were measured
     * against (`#976`).
     *
     * **After the backfill, because the rows it scopes are ones the backfill
     * created.** A pass that ran first would find nothing on its first deploy
     * and leave `agentphone.ai` globally refused until the next one — which is
     * the state this issue exists to end.
     */
    const { scoped, untouched: alreadyScoped } = await scopeTelephonyDirections(db)
    console.log(
      `atlas directions: ${scoped} telephony verdicts scoped to the direction they measured, ` +
        `${alreadyScoped} already scoped or not yet on a shelf`,
    )

    /**
     * One provider, one row per account kind (`#1144`).
     *
     * **Before the shelf repair, because it decides which rows there are to
     * shelve.** A row it moves onto the canonical kind is a row whose shelf the
     * pass below then checks in the same run; the other order would shelve a
     * twin and then delete it.
     */
    const kinds = await reconcileAtlasKinds(db)
    console.log(
      `atlas kinds: ${kinds.moved} entries moved onto the kind their spelling means, ` +
        `${kinds.dropped} empty twins dropped, ${kinds.walks} walks and ${kinds.reports} verdicts re-keyed, ` +
        `${kinds.briefings} briefings left to be rewritten, ` +
        `${kinds.conflicted} pairs left alone because both rows carry findings`,
    )

    /**
     * Every entry on the shelf its kind names (`#917`), last of the Atlas passes.
     *
     * **After all three, because it repairs what they write rather than writing
     * anything itself.** A listing, a curation and a backfill each derive the
     * shelf from the kind and are already right; what this catches is the rows
     * written before `#807` closed the `data-apis` fallback, and running it last
     * means it also covers anything the passes above created in this same run.
     */
    const { moved, agreed, unshelved: unshelvable } = await repairAtlasShelves(db)
    console.log(
      `atlas shelves: ${moved} entries moved to the shelf their kind names, ` +
        `${agreed} already there, ${unshelvable} left alone for want of a shelf`,
    )

    const bundles = await seedBundles(db)
    console.log(`provider bundles: ${bundles} written`)
  } finally {
    await db.close()
  }
}

await main()
