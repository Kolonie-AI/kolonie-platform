import type { AtlasBand } from '@kolonie-ai/core'
import type { AtlasPublicEntry, AtlasPublicRecipe } from './public-projection.js'

/**
 * What the page claims, as one value the title, the lead and the shelf all read
 * (`#1163`).
 *
 * ## The contradiction this exists to make unrepresentable
 *
 * Measured 2026-08-17 on live `kolonie.ai/atlas/agentphone.ai`: the title said
 * *why an agent cannot join it*, the lead said *This cannot be joined honestly,
 * so do not try*, and four sections below them listed browser signup, REST
 * signup, an API key and inbound SMS polling, each with the walk counts behind
 * it. The same page marketed a refusal and documented the successes.
 *
 * Neither half was a bug on its own. `status` is a **steward's verdict about the
 * route** and it was correctly `refused`; {@link atlasEntryWorked} reads the
 * **measured figures** and they correctly said somebody got in. Two questions,
 * two right answers, and a page that put one of them in the headline and the
 * other in the body — so a reader had to reach the fourth section to find out
 * that the first sentence was about something narrower than it sounded.
 *
 * A verdict is therefore not a rename of `status`. It is the answer to *what may
 * this page say at the top*, computed from the status **and** the measurement,
 * and it has a fourth value for the case that had nowhere to go:
 * {@link ATLAS_PARTLY}.
 *
 * ## What each value means
 *
 * - `joinable` — an honest route is known and the Colony stands behind it.
 * - `partly` — something measurably got through, and no route stands. What got
 *   through and what did not are both findings, and neither is the headline on
 *   its own.
 * - `refused` — nothing measurably got through, and somebody has looked and said
 *   why. This is the only value that may carry *do not try*.
 * - `unwritten` — nothing measured. Not a verdict about the provider at all.
 *
 * **The names are the page's and not the database's**, deliberately: `status`
 * keeps its five values, every row keeps its own, and nothing here is written
 * back. A capability's own verdict is {@link atlasRecipeVerdict} and an entry
 * rolls its rows up in {@link atlasEntryVerdict}, so the *per capability* half of
 * `#1163` is where the sections already are.
 */
export type AtlasVerdict = 'joinable' | 'partly' | 'refused' | 'unwritten'

/** The value a page may never put *do not try* above. */
export const ATLAS_PARTLY = 'partly' satisfies AtlasVerdict

/**
 * One capability's verdict.
 *
 * **A row is refused only where nothing got through.** That is the whole of the
 * change `#1163` makes: a refusal with measured successes behind it is a route
 * that is closed at some step, not a provider nobody has ever got into, and the
 * two read differently to somebody deciding whether to spend an afternoon.
 *
 * **`measured` splits the same way**, and for the same reason. `#1032` made it
 * *a walk closed here and nobody wrote the route*; where that walk got through it
 * is a partial finding, and where it did not there is nothing yet to tell a
 * reader beyond the fact that somebody looked — which the row's own section says
 * in its own words, and which no headline should turn into a verdict.
 */
export function atlasRecipeVerdict(recipe: AtlasPublicRecipe): AtlasVerdict {
  if (recipe.status === 'joinable') return 'joinable'
  if (recipe.status === 'unwritten') return 'unwritten'
  if (!atlasRecipeGotThrough(recipe)) {
    return recipe.status === 'measured' ? 'unwritten' : 'refused'
  }

  return ATLAS_PARTLY
}

/**
 * The whole entry's verdict, rolled up from its rows.
 *
 * **The order is the order of what a headline may claim**, and it is not
 * `atlasEntryStatus`'s order by accident: a joinable row is a route somebody can
 * walk today and outranks everything, a partial finding outranks a refusal
 * because the refusal is then about part of the page, and `unwritten` is last
 * because it is the absence of an answer rather than one.
 *
 * **`entry.status` is still read**, for the entry that has it and rows that do
 * not — a rollup written by a steward is an answer about the provider, and the
 * only thing this refuses it is the power to overrule a measurement underneath
 * it.
 */
export function atlasEntryVerdict(entry: AtlasPublicEntry): AtlasVerdict {
  const verdicts = entry.recipes.map(atlasRecipeVerdict)

  if (entry.status === 'joinable' || verdicts.includes('joinable')) return 'joinable'
  if (verdicts.includes(ATLAS_PARTLY)) return ATLAS_PARTLY
  if (verdicts.includes('refused')) return 'refused'
  if (entry.status === 'refused' || entry.status === 'retired') return 'refused'

  return 'unwritten'
}

/**
 * Whether anybody measurably got through on one row.
 *
 * **This is `worked.ts`'s `provedHere`, moved rather than copied** (`#1163`).
 * The shelf's *what worked* default and the page's headline were two readings of
 * one fact and drifted the moment either was edited; they now read the same
 * function, and {@link atlasEntryWorked} is expressed in terms of the verdict.
 *
 * `evidenced` is the gate because a declaration is not evidence (`#977`).
 *
 * **The count is not read on its own, because `proved` is floored.**
 * `ATLAS_FIGURE_FLOOR` zeroes every count on a row of fewer than five attempts,
 * and measured 2026-08-15 that is every walked pair in production — so a literal
 * *`proved` greater than zero* would answer **no** for exactly the row this
 * exists to surface, the one where a single citizen got in. `anyProved` is what
 * answers there (`#1167`): the same fact read off the count before the flooring,
 * published as a boolean because *a citizen got in here* names nobody. The two
 * cannot disagree, since one is the other thresholded.
 *
 * `walked` is read beside them. A walk closed `proved` is a walker's account
 * rather than the Colony's measurement, and `anyProved` deliberately does not
 * take it — but a page that shows what worked should show the entry somebody
 * walked through, so it counts here even though it does not count there. Its
 * band is read as well as its count for the flooring reason again:
 * `most-got-through` and `about-half` each mean a rate of at least 0.4, which
 * cannot be reached with nothing proved, while `few-got-through` covers a rate of
 * zero and one in ten alike and so decides nothing.
 */
export function atlasRecipeGotThrough(recipe: AtlasPublicRecipe): boolean {
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
 * Whether a band can only have been produced with at least one proved walk.
 *
 * `atlasBand` puts a rate above 0.6 in the first and at least 0.4 in the second,
 * and neither is reachable from zero. This is a floor-proof reading of *at least
 * one* and not a quality bar: nothing here compares one provider with another.
 */
function atLeastOneProved(band: AtlasBand | null): boolean {
  return band === 'most-got-through' || band === 'about-half'
}
