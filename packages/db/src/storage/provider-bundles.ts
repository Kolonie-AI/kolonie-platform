import { asc, eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  inBundleOrder,
  leadsWithTheCheapAccounts,
  AtlasCategorySchema,
  RecipeOperatorGuessSchema,
  RecipeStatusSchema,
  operatorNeed,
  type AtlasCategory,
  type Bundle,
  type BundleEntry,
  type RecipeOperatorNeed,
  type RecipeStatus,
  type RecipeStep,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { providerBundleEntries, providerBundles, providerRecipes } from '../schema/index.js'

/**
 * The bundles, seeded and read (#531).
 *
 * **There is no write surface and that is deliberate for now.** A bundle is a
 * recommendation the Colony makes, and `#531` is explicit that it is *not a
 * store front* — so it is seeded from {@link BUNDLES} the way the Academy's
 * rungs are, and changing one is a change to this repository rather than a form
 * somebody fills in. A catalogue entry is a citizen's or a provider's to write
 * (`#525`); which entries the Colony *recommends together* is the Colony's.
 */

/**
 * The operator answer for one joined row, derived rather than read (`#589`).
 *
 * A left join gives `null` steps for a provider that is not in the catalogue at
 * all; a row that *is* there always has its array, empty or not, and
 * `operatorNeed` answers `unknown` for the empty one.
 */
function operatorAnswer(
  steps: RecipeStep[] | null,
  guess: string | null,
): { readonly operatorNeed: RecipeOperatorNeed; readonly operatorNeedIsGuess: boolean } {
  const answered = operatorNeed({
    steps: steps ?? [],
    operatorGuess: guess === null ? null : RecipeOperatorGuessSchema.parse(guess),
  })

  return { operatorNeed: answered.need, operatorNeedIsGuess: answered.isGuess }
}

/** One entry as the reader returns it, with what the catalogue knows about it. */
export interface BundleEntryView extends BundleEntry {
  /** The catalogue's title, or `null` when nobody has written the entry yet. */
  readonly title: string | null
  /**
   * What the catalogue says about joining this provider.
   *
   * **`null` means the provider is not in the catalogue at all**, which is a
   * fourth answer and not a missing one. `#588` gave the catalogue its own word
   * for *listed but nobody has looked* — `'unwritten'` — and the two are
   * genuinely different to an operator: one says the Colony has never heard of
   * this provider, the other says it has and has not investigated it.
   */
  readonly status: RecipeStatus | null
  /** The shelf it sits on, or `null` when it is not in the catalogue (`#589`). */
  readonly category: AtlasCategory | null
  /**
   * Whether an agent can walk it alone (`#589`).
   *
   * Derived from the stored steps by the same `operatorNeed` every other surface
   * uses, so a bundle row and the Atlas page it links to cannot disagree. `null`
   * only where there is no row at all.
   */
  readonly operatorNeed: RecipeOperatorNeed | null
  /** True when the answer above is a guess rather than a walked step. */
  readonly operatorNeedIsGuess: boolean
  /** Why not, when the catalogue says it cannot be joined. */
  readonly refusal: string | null
}

export interface BundleView {
  readonly slug: string
  readonly title: string
  readonly reason: string
  readonly entries: readonly BundleEntryView[]
}

/**
 * Every bundle, with what the catalogue currently says about each entry.
 *
 * **A left join, so an entry nobody has written yet is still shown.** Hiding it
 * would make a bundle silently shorter than it was designed to be, and the
 * operator would have no way to know a recommendation had been trimmed by a gap
 * in the catalogue rather than by somebody's judgement.
 */
export async function bundles(db: Database | Transaction): Promise<readonly BundleView[]> {
  const rows = await db
    .select({
      slug: providerBundles.slug,
      title: providerBundles.title,
      reason: providerBundles.reason,
      kind: providerBundleEntries.kind,
      provider: providerBundleEntries.provider,
      entryTitle: providerRecipes.title,
      status: providerRecipes.status,
      category: providerRecipes.category,
      steps: providerRecipes.steps,
      operatorGuess: providerRecipes.operatorGuess,
      refusal: providerRecipes.refusal,
    })
    .from(providerBundles)
    .innerJoin(providerBundleEntries, eq(providerBundleEntries.bundleSlug, providerBundles.slug))
    .leftJoin(
      providerRecipes,
      sql`${providerRecipes.kind} = ${providerBundleEntries.kind}
          and ${providerRecipes.provider} = ${providerBundleEntries.provider}`,
    )
    .orderBy(asc(providerBundles.slug))

  const held = new Map<string, BundleView>()

  for (const row of rows) {
    const bundle = held.get(row.slug) ?? {
      slug: row.slug,
      title: row.title,
      reason: row.reason,
      entries: [],
    }

    held.set(row.slug, {
      ...bundle,
      entries: [
        ...bundle.entries,
        {
          kind: AccountKindSchema.parse(row.kind),
          provider: AccountProviderSchema.parse(row.provider),
          title: row.entryTitle,
          status: row.status === null ? null : RecipeStatusSchema.parse(row.status),
          category: row.category === null ? null : AtlasCategorySchema.parse(row.category),
          ...(row.status === null
            ? { operatorNeed: null, operatorNeedIsGuess: false }
            : operatorAnswer(row.steps, row.operatorGuess)),
          refusal: row.refusal,
        },
      ],
    })
  }

  /**
   * The order is applied here and is stored nowhere (`#548`).
   *
   * `inBundleOrder` is the rule — see it for why a stored ordering column would
   * be a placement somebody could later be sold.
   */
  return [...held.values()].map((bundle) => ({
    ...bundle,
    entries: inBundleOrder(bundle.entries).map(
      (entry) =>
        bundle.entries.find(
          (held) => held.kind === entry.kind && held.provider === entry.provider,
        ) as BundleEntryView,
    ),
  }))
}

/** One bundle's entries, in order, or `undefined`. */
export async function bundleNamed(
  db: Database | Transaction,
  slug: string,
): Promise<BundleView | undefined> {
  return (await bundles(db)).find((bundle) => bundle.slug === slug)
}

/** Both fields are branded, so the literals below are parsed rather than cast. */
const entry = (kind: string, provider: string): BundleEntry => ({
  kind: AccountKindSchema.parse(kind),
  provider: AccountProviderSchema.parse(provider),
})

/**
 * The bundles the Colony recommends.
 *
 * **Three, and each answers a different question an operator actually has.** A
 * fourth should be added when somebody can say which question it answers that
 * these do not — a list of bundles is a catalogue again, and the whole point is
 * that an operator with one agent should not have to read one.
 *
 * Every one of them leads with `mailbox` and `phone`, and `provider-bundles.test.ts`
 * asserts that rather than trusting this sentence.
 */
export const BUNDLES: readonly Bundle[] = [
  {
    slug: 'starter',
    title: 'The minimum, before anything else is easy',
    /**
     * **This is the bundle the ordering rule exists for.** Both of its entries
     * are the ones that take the operator out of the loop, and everything an
     * agent does afterwards is cheaper for having them.
     */
    reason:
      'A mailbox and a number. Not the most valuable accounts an agent can hold — the two that ' +
      'stop you having to fetch a confirmation code out of your own mail, or read an SMS off ' +
      'your own handset, every time it signs up for anything else.',
    entries: [entry('mailbox', 'openmail.sh'), entry('phone', 'twilio.com')],
  },
  {
    slug: 'design',
    title: 'An agent that does design work',
    reason:
      'Somewhere to keep files, somewhere to publish them, and an account at a tool that makes ' +
      'them. The mailbox and the number come first because every one of the others will send a ' +
      'code to one or the other; the rest are alphabetical, because any more interesting order ' +
      'would be the Colony ranking providers against each other.',
    entries: [
      entry('mailbox', 'openmail.sh'),
      entry('phone', 'twilio.com'),
      entry('website', 'github.com'),
      entry('image-model', 'openai.com'),
    ],
  },
  {
    slug: 'research',
    title: 'An agent that researches and writes things down',
    reason:
      'Somewhere to read from, somewhere to keep what it found, and somewhere to be read. Again ' +
      'the mailbox and the number lead, for the same reason they always do, and the rest are ' +
      'alphabetical for the same reason they always are.',
    entries: [
      entry('mailbox', 'openmail.sh'),
      entry('phone', 'twilio.com'),
      entry('social', 'bsky.app'),
      entry('github', 'github.com'),
    ],
  },
]

/**
 * Write the bundles into the database, idempotently.
 *
 * **It refuses to seed a bundle written out of order**, rather than silently
 * reordering it. The read derives the order anyway, so this changes nothing a
 * user sees — what it protects is the *source*: a definition in this file that
 * reads bottom-up would tell the next person the rule is not real.
 */
export async function seedBundles(db: Database): Promise<number> {
  for (const bundle of BUNDLES) {
    if (!leadsWithTheCheapAccounts(bundle.entries)) {
      throw new Error(
        `the bundle "${bundle.slug}" does not lead with the accounts that remove operator work. ` +
          'A mailbox and a number come first in every bundle — see BUNDLE_LEADING_KINDS.',
      )
    }
  }

  return db.transaction(async (tx) => {
    for (const bundle of BUNDLES) {
      await tx
        .insert(providerBundles)
        .values({ slug: bundle.slug, title: bundle.title, reason: bundle.reason })
        .onConflictDoUpdate({
          target: providerBundles.slug,
          set: { title: bundle.title, reason: bundle.reason, updatedAt: sql`now()` },
        })

      // Replaced rather than merged, so an entry taken out of a bundle in this
      // file is taken out of the database on the next deploy.
      await tx
        .delete(providerBundleEntries)
        .where(eq(providerBundleEntries.bundleSlug, bundle.slug))

      await tx.insert(providerBundleEntries).values(
        bundle.entries.map((entry) => ({
          bundleSlug: bundle.slug,
          kind: entry.kind,
          provider: entry.provider,
        })),
      )
    }

    return BUNDLES.length
  })
}
