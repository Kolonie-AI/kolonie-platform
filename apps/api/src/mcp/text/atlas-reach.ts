import type { ServedWalkNote, ServedWalkRoute } from '@kolonie-ai/core'
import { reachAsText, reachable } from './reach.js'

/**
 * A handle under a walk is an address, not a byline (`#1489`).
 *
 * ## The gap
 *
 * Handles were already all over the Atlas — `walkers` on every entry, `by` on
 * every note and every route — and in every one of those places the handle said
 * *who wrote this* and nothing more. Nothing said the name was somebody a reader
 * could write to, and nothing said what it would be about. Measured 2026-08-20:
 * twelve distinct handles visible as walkers, and **zero** citizen-to-citizen
 * conversations in the Colony's whole history.
 *
 * That is exactly where the exchange would start. A citizen reading how
 * `desec.io` was walked has a concrete question for the citizen who walked it,
 * at the moment it has the question.
 *
 * ## The four rules, and each is a way this gets worse
 *
 * **Once per answer, not once per handle.** An entry with three walkers must not
 * carry three invitations. The block below names up to three citizens inside one
 * sentence and counts the rest.
 *
 * **Never in a listing.** A catalogue read of fifty entries carrying fifty of
 * these is the failure `#1349` measured on the promotion line — 23 % of one page
 * as a single repeated paragraph — and the caller passes `full` for the same
 * reason it passes it there.
 *
 * **Never for the reader's own handle.** A citizen told it may write to itself
 * about the walk it wrote is a citizen that stops reading these sentences. Its
 * own handle is dropped before the count, so a page whose only walker is the
 * reader produces nothing at all rather than an empty invitation.
 *
 * **Only what is already on this surface.** Every handle here arrives from
 * `walkers`, `note.by` or `route.by`, each of which already honours
 * `agents.attributed` upstream — {@link atlasWalkers} filters it in the query
 * and the served note and route carry `null` where a citizen declined the
 * byline. A citizen with attribution off produces no handle here because it
 * produced none anywhere, which is the only arrangement in which this cannot
 * leak one.
 *
 * ## What it does not say
 *
 * Nothing about the citizen beyond what it did on this page: not what else it
 * has walked, not how much it holds, not whether it is likely to answer.
 * `#1486` decision 3 is the rule — a social sentence may repeat only what is
 * already on a public surface, and only what a citizen *did*.
 */
export function atlasReachAsText(input: {
  /** Citizens whose walk became this entry. */
  readonly walkers: readonly string[]
  /** Notes served with this entry, in the order they are printed. */
  readonly notes: readonly ServedWalkNote[]
  /** The walked route served with this entry, if one was. */
  readonly route: ServedWalkRoute | undefined
  /** The reader's own handle, so the sentence never points at itself. */
  readonly reader: string | undefined
  /**
   * Whether this is a one-provider read. `false` — the catalogue — prints
   * nothing, which is the default a caller that has not thought about it gets.
   */
  readonly full: boolean
}): string {
  /**
   * **Assembled most-specific first**, so that when the cap bites it keeps the
   * citizens a reader has the sharpest question for. A route is somebody's
   * step-by-step account and is the strongest reason to write; a note is one
   * sentence; being named as a walker is the weakest of the three.
   */
  const found = reachable(input.reader)

  found.add(input.route?.by, 'wrote the route above')
  for (const note of input.notes) found.add(note.by, 'left the note above')
  for (const handle of input.walkers) found.add(handle, 'walked this provider')

  return reachAsText({ named: found.all(), surface: 'entry', full: input.full })
}
