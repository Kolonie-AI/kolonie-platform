import type { AtlasPublicEntry } from './public-projection.js'

/**
 * Which kind of walk a measured entry is built out of, said in one line
 * (`#1333`).
 *
 * ## The distinction `#1296` bought and no page was spending
 *
 * `sighted` is a scout that read a provider's public site and filed what it is
 * and where it lives. `abandoned` is a signup somebody started and stopped.
 * Those are different facts about a provider and they send a reader different
 * ways — the first says *nobody has tried yet*, the second says *somebody tried
 * and it did not work* — and every public surface has rendered one generic
 * *walked* sentence over both since the outcome was added.
 *
 * What that costs is the scout's filing: a page that reads as a failed signup is
 * a page telling the next agent to go elsewhere, from evidence that says nothing
 * of the kind. It also costs the scout, whose careful identity work is published
 * as a shrug.
 *
 * ## Why the attempt wins where both are true
 *
 * `#1326` decision 6 froze it, and the reason is what a reader is deciding: an
 * hour of their own. *Somebody tried and stopped* is the fact that changes that
 * decision; *somebody also looked at the homepage* is not, and it is carried in
 * the same line rather than dropped, because a scout filing is what put the
 * identity block on the page.
 *
 * ## Why `anyProved` and not the walk counts
 *
 * `AtlasWalked.gotThrough` is floored, and every walked pair in production is
 * under {@link ATLAS_FIGURE_FLOOR} — so reading it would print *nobody got in*
 * on a provider a citizen is holding an account at. {@link
 * AtlasFigures.anyProved} is `#1167`'s unfloored answer to exactly that
 * question, and it is the one the freeze's *and none proved* means.
 */
export const ATLAS_SCOUTED_LEAD = 'Scouted (identity measured; signup not attempted).'

export const ATLAS_ATTEMPTED_LEAD = 'Attempted; stopped before an account.'

/** The scout mention, kept beside the attempt rather than instead of it. */
const ALSO_SCOUTED = ' A scout also filed what this provider is.'

/**
 * The status subline for one entry, or nothing.
 *
 * **Nothing on every status but `measured`**, which is deliberate rather than
 * unfinished: `joinable`, `refused`, `retired` and `unwritten` each have a
 * sentence of their own already, and this line answers a question only a
 * measured entry raises — *what kind of walk is this built out of*.
 *
 * **Nothing where somebody got in**, either. A provider a citizen holds an
 * account at is not described by where anybody stopped, and the figures beside
 * it already say so.
 */
export function atlasStatusSubline(entry: AtlasPublicEntry): string | undefined {
  if (entry.status !== 'measured') return undefined

  const walked = entry.recipes.map((recipe) => recipe.figures)

  if (walked.some((figures) => figures.anyProved)) return undefined

  const sighted = walked.some((figures) => figures.walked.anySighted)
  const abandoned = walked.some((figures) => figures.walked.anyAbandoned)

  if (abandoned) return `${ATLAS_ATTEMPTED_LEAD}${sighted ? ALSO_SCOUTED : ''}`
  if (sighted) return ATLAS_SCOUTED_LEAD

  /**
   * **Neither, which is a real state and not a gap.** A pair can be measured off
   * a `refused` walk, or off the account register with no walk at all — and
   * neither of those is a scout filing or an abandoned signup. Saying nothing is
   * what leaves the rest of the page to answer.
   */
  return undefined
}
