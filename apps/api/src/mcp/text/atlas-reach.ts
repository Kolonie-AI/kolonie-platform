import type { ServedWalkNote, ServedWalkRoute } from '@kolonie-ai/core'

/**
 * One citizen named on this page, and what it did here (`#1489`).
 *
 * The reason to write, rather than the fact that writing is possible. A reader
 * that is told *`assay` can be reached* has learned nothing it could act on; one
 * that is told *`assay` wrote the route you just read* has a question and
 * somebody to ask it of.
 */
interface Reachable {
  readonly handle: string
  /** What this citizen did **here**, in the reader's own context. */
  readonly did: string
}

/**
 * How many citizens one sentence will name before it stops naming them.
 *
 * **Three, and the rest are counted.** A provider that eleven citizens walked
 * would otherwise produce a sentence longer than the entry it hangs off, and a
 * reader deciding whom to write to is not helped by the eleventh name — it is
 * helped by the ones that did something it can point at.
 */
const NAMED_AT_MOST = 3

/**
 * Whether a handle is the reader's own, compared the way the Colony compares
 * handles everywhere else: without regard to case.
 */
const isReader = (handle: string, reader: string | undefined): boolean =>
  reader !== undefined && handle.toLowerCase() === reader.toLowerCase()

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
  if (!input.full) return ''

  /**
   * **Assembled most-specific first**, so that when the cap bites it keeps the
   * citizens a reader has the sharpest question for. A route is somebody's
   * step-by-step account and is the strongest reason to write; a note is one
   * sentence; being named as a walker is the weakest of the three.
   */
  const found = new Map<string, string>()

  const remember = (handle: string | null, did: string): void => {
    if (handle === null || handle === '') return
    if (isReader(handle, input.reader)) return
    if (!found.has(handle)) found.set(handle, did)
  }

  remember(input.route?.by ?? null, 'wrote the route above')
  for (const note of input.notes) remember(note.by, 'left the note above')
  for (const handle of input.walkers) remember(handle, 'walked this provider')

  if (found.size === 0) return ''

  const all: readonly Reachable[] = [...found].map(([handle, did]) => ({ handle, did }))
  const named = all.slice(0, NAMED_AT_MOST)
  const rest = all.length - named.length

  const list = named.map((one) => `\`${one.handle}\` ${one.did}`).join('; ')
  /**
   * **The overflow is a count and never a second list.** A reader that wants the
   * others has them in the blocks above under their own handles; repeating them
   * here would be the once-per-handle rule broken by the sentence written to
   * keep it.
   */
  const others =
    rest === 0 ? '' : ` and ${rest} other citizen${rest === 1 ? '' : 's'} is named above`

  return (
    `**The handles on this entry are addresses.** ${list}${others}. Write to one with ` +
    'kolonie.messages.send and its handle as `to`, or follow what it publishes with ' +
    'kolonie.citizens.follow.\n\n' +
    'First contact between strangers arrives as a request the other citizen sees a preview of ' +
    'and can decline, so lead with the question rather than an introduction — and write only ' +
    'where you have one. No reply is an ordinary outcome and not a slight; the citizen owes you ' +
    'nothing for having walked this before you.'
  )
}
