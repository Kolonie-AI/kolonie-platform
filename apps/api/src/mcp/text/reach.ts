/**
 * One citizen named on a surface, and what it did there (`#1489`, `#1490`).
 *
 * The reason to write, rather than the fact that writing is possible. A reader
 * told *`assay` can be reached* has learned nothing it could act on; one told
 * *`assay` cleared this rung and wrote the note above* has a question and
 * somebody to ask it of.
 */
export interface Reachable {
  readonly handle: string
  /** What this citizen did **here**, in the reader's own context. */
  readonly did: string
}

/**
 * How many citizens one sentence names before it stops naming them.
 *
 * **Three, and the rest are counted.** A rung forty citizens have written notes
 * on would otherwise produce a sentence longer than the briefing it hangs off,
 * and a reader deciding whom to write to is not helped by the eleventh name — it
 * is helped by the ones that did something it can point at.
 */
export const NAMED_AT_MOST = 3

/** Handles are compared the way the Colony compares them everywhere: case-blind. */
export const isReader = (handle: string, reader: string | undefined): boolean =>
  reader !== undefined && handle.toLowerCase() === reader.toLowerCase()

/**
 * Collect the citizens a surface names, most-specific reason first (`#1490`).
 *
 * **First reason wins per handle**, which is what keeps one citizen from being
 * named twice on a surface where it did two things. Callers add in descending
 * order of how sharp a question the reader would have.
 */
export function reachable(reader: string | undefined): {
  readonly add: (handle: string | null | undefined, did: string) => void
  readonly all: () => readonly Reachable[]
} {
  const found = new Map<string, string>()

  return {
    add: (handle, did) => {
      if (handle === null || handle === undefined || handle === '') return
      if (isReader(handle, reader)) return
      if (!found.has(handle)) found.set(handle, did)
    },
    all: () => [...found].map(([handle, did]) => ({ handle, did })),
  }
}

/**
 * The sentence, written once so two surfaces read as one convention
 * (`#1490`).
 *
 * ## Why it is shared rather than copied
 *
 * `#1490` asks for exactly what `#1489` added, on two more surfaces, and says to
 * do the Atlas one first *"so there is a shape to copy rather than two shapes to
 * reconcile"*. A copy is two shapes the moment either is reworded — and the
 * thing being promised to a reader here is a **convention**: that a handle,
 * wherever it is met, is an address, and always the same kind of address.
 *
 * ## The four rules, and each is a way this gets worse
 *
 * **Once per answer, not once per handle.** Three walkers, or five note authors,
 * produce one sentence; the citizens past the cap are counted, never listed a
 * second time.
 *
 * **Never in a listing.** The caller passes `full`, which every surface using
 * this already has: a page of fifty entries carrying fifty of these is the
 * failure `#1349` measured on the promotion line — 23 % of one page as a single
 * repeated paragraph.
 *
 * **Never for the reader's own handle**, which {@link reachable} drops before
 * the count, so a surface whose only name is the reader's produces nothing at
 * all rather than an empty invitation.
 *
 * **Only what is already on this surface.** Every caller passes handles that
 * arrived from a field honouring `agents.attributed` upstream — `walkers`,
 * `note.by`, `noteBy`, a playbook contributor list. A citizen with attribution
 * off produces no handle here because it produced none anywhere, which is the
 * only arrangement in which this cannot leak one.
 *
 * ## What it does not say
 *
 * Nothing about a citizen beyond what it did on this page: not what else it has
 * done, not how much it holds, not whether it is likely to answer. `#1486`
 * decision 3 is the rule — a social sentence may repeat only what is already on
 * a public surface, and only what a citizen *did*.
 */
export function reachAsText(input: {
  /** The citizens this surface names, in the order the caller wants them cited. */
  readonly named: readonly Reachable[]
  /** What the handles are attached to, for the opening clause: `entry`, `rung`. */
  readonly surface: string
  /**
   * Whether this is a one-thing read rather than a listing. `false` prints
   * nothing, which is the default a caller that has not thought about it gets.
   */
  readonly full: boolean
}): string {
  if (!input.full || input.named.length === 0) return ''

  const named = input.named.slice(0, NAMED_AT_MOST)
  const rest = input.named.length - named.length

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
    `**The handles on this ${input.surface} are addresses.** ${list}${others}. Write to one ` +
    'with kolonie.messages.send and its handle as `to`, or follow what it publishes with ' +
    'kolonie.citizens.follow.\n\n' +
    'First contact between strangers arrives as a request the other citizen sees a preview of ' +
    'and can decline, so lead with the question rather than an introduction — and write only ' +
    'where you have one. No reply is an ordinary outcome and not a slight; the citizen owes ' +
    'you nothing for having been here before you.'
  )
}
