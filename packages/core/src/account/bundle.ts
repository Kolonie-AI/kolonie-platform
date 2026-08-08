import { z } from 'zod'
import { AccountKindSchema, AccountProviderSchema } from './account.js'

/**
 * A named set of catalogue entries, with a reason (#531).
 *
 * ## Who this is for
 *
 * `#521` gives the Colony a catalogue of providers, and a catalogue is what an
 * operator with ten agents needs. **An operator with one agent needs a
 * recommendation.** Batching helps nobody who has nothing to batch; what helps
 * is not having to decide, and eighty entries to read through is worse than
 * none.
 *
 * ## A bundle is a row of references and never a copy
 *
 * The entries are the catalogue's. A bundle names which of them belong together
 * and why, and holds no title, no steps and no proof method of its own — so an
 * entry that changes changes everywhere at once, and a provider that stops
 * accepting agents stops in the bundle too.
 *
 * ## Not a store front
 *
 * No pricing, no tiers, no *recommended* badges. A bundle is a starting point an
 * operator edits, and **the entries an operator removes are as informative as
 * the ones it keeps**.
 *
 * ## Not a promise that everything in it works
 *
 * A catalogue entry may record that a provider cannot currently be joined
 * (`#521`). A bundle shows that honestly rather than omitting the entry — an
 * operator that finds out later has been told something untrue, and an operator
 * that sees it now knows something about the world.
 */

/**
 * The kinds that take the operator out of the loop, in the order they do it.
 *
 * **This is the ordering rule and it is a fact about the operator's time rather
 * than about how valuable an account is.**
 *
 * | Once the agent has | The operator stops having to |
 * |---|---|
 * | a mailbox | fetch confirmation codes from mail |
 * | a phone number | read SMS codes |
 * | both | do anything except captchas and payments |
 *
 * So these come first in every bundle. A bundle that opens with Trello has spent
 * the operator's patience before buying anything with it.
 */
export const BUNDLE_LEADING_KINDS = ['mailbox', 'phone'] as const

/** How many entries one bundle may hold. */
export const BUNDLE_MAX_ENTRIES = 12

/** One entry a bundle points at. The catalogue holds everything else about it. */
export const BundleEntrySchema = z.object({
  kind: AccountKindSchema,
  provider: AccountProviderSchema,
})
export type BundleEntry = z.infer<typeof BundleEntrySchema>

export const BundleSchema = z.object({
  slug: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  /**
   * Why these belong together, in a sentence.
   *
   * **The whole value of a bundle over a filter.** *An agent that does design
   * work wants these five* is a recommendation; a list of five providers is a
   * shorter catalogue.
   */
  reason: z.string().min(1).max(400),
  entries: z.array(BundleEntrySchema).min(1).max(BUNDLE_MAX_ENTRIES),
})
export type Bundle = z.infer<typeof BundleSchema>

/**
 * A bundle's entries, in the order an operator should meet them.
 *
 * **Derived and never stored**, which is `#548`'s rule and the reason this is a
 * function rather than a `position` column: *"a field that exists will
 * eventually be set"*, and a settable order inside a bundle is a placement
 * somebody could later be sold. `#543` says paying buys nothing about ordering
 * and `#545` derives the Atlas's order on every read; this is the same
 * discipline one level in.
 *
 * The rule, in full:
 *
 * 1. {@link BUNDLE_LEADING_KINDS}, in their own order — a mailbox, then a
 *    number. Not because they are the most valuable accounts but because they
 *    are the two that take the operator out of the loop, and everything after
 *    them is cheaper for their being there.
 * 2. Everything else, by provider, alphabetically.
 *
 * **The second half is deliberately dull.** Any interesting tiebreak — how many
 * citizens hold one, how recently an entry was confirmed — would be a ranking of
 * providers against each other inside a recommendation, which is exactly what
 * `#543` refuses. Alphabetical cannot be bought and cannot be argued with.
 */
export function inBundleOrder(entries: readonly BundleEntry[]): readonly BundleEntry[] {
  const leadingRank = (entry: BundleEntry): number => {
    const at = (BUNDLE_LEADING_KINDS as readonly string[]).indexOf(entry.kind)
    return at === -1 ? BUNDLE_LEADING_KINDS.length : at
  }

  return [...entries].sort(
    (a, b) => leadingRank(a) - leadingRank(b) || a.provider.localeCompare(b.provider),
  )
}

/**
 * Whether these entries are already in that order.
 *
 * Kept beside it because a reader of a *stored* list — a bundle read back out of
 * the database, or one written into a test — should be able to ask.
 */
export function leadsWithTheCheapAccounts(entries: readonly BundleEntry[]): boolean {
  return inBundleOrder(entries).every(
    (entry, at) => entry.provider === entries[at]?.provider && entry.kind === entries[at]?.kind,
  )
}

/** What an operator sends to put a bundle on an agent's list. */
export const SelectBundleSchema = z.object({
  slug: z.string().min(1).max(64),
  /**
   * Which entries to take, as `kind:provider`.
   *
   * **Absent means all of them**, which is the one-click case the bundle exists
   * for. Present and shorter is an operator that edited the bundle before
   * starting, which `#531` requires and which is also the most useful signal the
   * Colony gets about whether a bundle is right.
   */
  entries: z.array(z.string()).max(BUNDLE_MAX_ENTRIES).optional(),
})
export type SelectBundle = z.infer<typeof SelectBundleSchema>
