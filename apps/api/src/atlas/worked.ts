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
 * ## Why the count is not read on its own
 *
 * `proved` is floored. `ATLAS_FIGURE_FLOOR` zeroes every count on a row of fewer
 * than five attempts, and measured 2026-08-15 that is every walked pair in
 * production — so a literal *`proved` greater than zero* would answer **no** for
 * exactly the entry decision 2 exists to surface, the one where a single citizen
 * got in.
 *
 * **`anyProved` is what answers there** (`#1167`): the same fact read off the
 * count before the flooring, published as a boolean because *a citizen got in
 * here* names nobody. The count is still read above it, for the rows where it
 * survives — the two cannot disagree, since one is the other thresholded.
 *
 * Until `anyProved` existed this function inferred *at least one* from the band,
 * which was sound as far as it went — `most-got-through` and `about-half` each
 * mean a rate of at least 0.4 and neither is reachable from zero — and wrong at
 * the bottom of the range: a provider six citizens attempted and one got into
 * bands `few-got-through`, and the entry the single arrival is the whole story of
 * fell off the default. That arm is gone rather than kept as a belt, because an
 * inference the row now states outright is a second place for it to drift.
 *
 * `walked` is still read beside it. A walk closed `proved` is a walker's account
 * rather than the Colony's measurement, and `anyProved` deliberately does not
 * take it — but a page that shows what worked should show the entry somebody
 * walked through, so it counts here even though it does not count there.
 */
export function atlasEntryWorked(entry: AtlasPublicEntry): boolean {
  return entry.status === 'joinable' || entry.recipes.some(provedHere)
}

function provedHere(recipe: AtlasPublicRecipe): boolean {
  const { figures } = recipe
  if (!figures.evidenced) return false

  return (
    figures.proved > 0 ||
    figures.anyProved ||
    figures.walked.gotThrough > 0 ||
    atLeastOneProved(figures.walked.band)
  )
}

/**
 * Whether a walked band can only have been produced with at least one arrival.
 *
 * `atlasBand` puts a rate above 0.6 in the first and at least 0.4 in the second,
 * and neither is reachable from zero. `AtlasWalked.gotThrough` is floored and its
 * band is not, so this is the floor-proof reading of *at least one walker
 * arrived* — and not a quality bar: nothing here compares one provider with
 * another. **`few-got-through` decides nothing** and is deliberately not read: it
 * covers a rate of zero and a rate of one in ten alike, so the row falls to
 * `anyProved`, which knows.
 */
function atLeastOneProved(band: AtlasBand | null): boolean {
  return band === 'most-got-through' || band === 'about-half'
}
