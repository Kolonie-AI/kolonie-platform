import type { AtlasBand } from '@kolonie-ai/core'
import type { AtlasPublicEntry, AtlasPublicRecipe } from './public-projection.js'

/**
 * Whether anybody got through at a provider (`#1103` decision 2).
 *
 * **The index shows what worked by default and one link shows what did not**, so
 * this predicate is the whole of that default. It is deliberately not a rate and
 * not a threshold: an agent looking for a mailbox wants the providers somebody
 * has actually joined, and *somebody joined this* is a fact about one walk rather
 * than a score to be tuned later.
 *
 * ## The two ways a row can say it
 *
 * **Status `joinable`** is a steward's verdict: the entry says a recipe here can
 * be walked honestly. **An evidenced figure with a proved walk** is the Colony's
 * own measurement, and `evidenced` is the gate on it because a declaration is not
 * evidence — `#977` settled that one level down and this reads it rather than
 * restating it.
 *
 * ## Why the band is read as well as the count
 *
 * `proved` is floored. `ATLAS_FIGURE_FLOOR` zeroes every count on a row of fewer
 * than five attempts, and measured 2026-08-15 that is every walked pair in
 * production — so a literal *`proved` greater than zero* would answer **no** for
 * exactly the entry decision 2 exists to surface, the one where a single citizen
 * got in. A band is computed before the flooring (`#792`, `#1032`) and survives
 * it, and `most-got-through` and `about-half` each mean a rate of at least 0.4,
 * which cannot be reached with nothing proved. So the band is read as a second
 * spelling of *at least one*, never as a rate the default filters on.
 *
 * **`few-got-through` decides nothing**, and that is the reason the band is not
 * simply thresholded: it covers a rate of zero and a rate of one in ten alike, so
 * it can neither prove nor disprove that anybody got through. A row that says
 * only that falls to the count, which under the floor says no — the conservative
 * answer, and the one where the entry keeps its page and appears one link away.
 */
export function atlasEntryWorked(entry: AtlasPublicEntry): boolean {
  return entry.status === 'joinable' || entry.recipes.some(provedHere)
}

function provedHere(recipe: AtlasPublicRecipe): boolean {
  const { figures } = recipe
  if (!figures.evidenced) return false

  return (
    figures.proved > 0 ||
    figures.walked.gotThrough > 0 ||
    atLeastOneProved(figures.band) ||
    atLeastOneProved(figures.walked.band)
  )
}

/**
 * Whether a band can only have been produced with at least one proved walk.
 *
 * `atlasBand` puts a rate above 0.6 in the first and at least 0.4 in the second,
 * and neither is reachable from zero. This is a floor-proof reading of *at least
 * one* and not a quality bar: nothing here compares one provider with another.
 */
function atLeastOneProved(band: AtlasBand | null): boolean {
  return band === 'most-got-through' || band === 'about-half'
}
