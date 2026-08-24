#!/usr/bin/env node

/**
 * What the Atlas catalogue actually holds, read from the published document
 * (`#1400`).
 *
 * Usage:
 *   node scripts/measure-atlas-catalogue.mjs [--url https://kolonie.ai/atlas/catalogue.json]
 *
 * ## Why this reads the catalogue and not the database
 *
 * **`#1400`'s acceptance criterion named two SQL queries, and both under-report
 * by construction.** They read `provider_recipes` and `provider_recipe_facets`.
 * The Atlas serves recipes *and* providers known only from a walk, so on
 * 2026-08-24 the tables held 195 recipes and 0 rows on the `earn` axis while the
 * published catalogue held **302 entries and 43 earn facets**. A reading taken
 * from the recipe table alone concludes there is no earn corpus, which is what
 * `D-136` concluded on 2026-08-23 and what this script exists to stop happening
 * again.
 *
 * `catalogue.json` is the document a third party stores and the same projection
 * every Atlas page renders from, so it is the corpus in the sense the epic meant.
 *
 * ## What it answers
 *
 * One question per section, and it proposes nothing:
 *
 * - how many entries there are, and where each came from
 * - how many sit on the utility fallback shelf, and how many of *those* carry an
 *   earn facet — the defect `#1400` opened on
 * - how many carry the identity copy `#1410` put above the fold
 */

import console from 'node:console'
import process from 'node:process'

const DEFAULT_URL = 'https://kolonie.ai/atlas/catalogue.json'

/**
 * The shelf an entry lands on when nothing better was chosen.
 *
 * Named here rather than imported: this script runs against a deployed Colony
 * that may be older than the working tree, and a constant that moved would make
 * the script measure the tree instead of the deployment.
 */
const FALLBACK_SHELF = 'data-apis'

function urlFrom(argv) {
  const at = argv.indexOf('--url')
  return at === -1 ? DEFAULT_URL : (argv[at + 1] ?? DEFAULT_URL)
}

/** The earn facets one entry carries, in the catalogue's own shape. */
function earnFacetsOf(entry) {
  return (entry.facets ?? [])
    .filter((facet) => facet !== null && typeof facet === 'object' && facet.axis === 'earn')
    .map((facet) => facet.slug)
}

function tally(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].sort((one, other) => other[1] - one[1])
}

const url = urlFrom(process.argv)
// Reached through `globalThis` rather than as a bare global: the eslint config
// declares no environment for a script, which is why `console` and `process`
// above are imported rather than assumed. `fetch` has no module to import from.
const response = await globalThis.fetch(url)
if (!response.ok) {
  console.error(`${url} answered ${response.status}`)
  process.exit(1)
}

const catalogue = await response.json()
const entries = catalogue.entries ?? []
if (entries.length === 0) {
  console.error(`${url} carries no entries — nothing to measure`)
  process.exit(1)
}

const onFallback = entries.filter((entry) => entry.category === FALLBACK_SHELF)
const earnOnFallback = onFallback.filter((entry) => earnFacetsOf(entry).length > 0)
const withDescription = entries.filter((entry) => (entry.description ?? '').trim() !== '')
const shelves = tally(entries.map((entry) => entry.category))

console.log(`read ${url}`)
console.log(`generated ${catalogue.generatedAt ?? 'at an unstated time'}`)
console.log('')
console.log(`entries                       ${entries.length}`)
for (const [source, count] of tally(entries.map((entry) => entry.source ?? 'unstated'))) {
  console.log(`  ${source.padEnd(28)}${count}`)
}
console.log('')
console.log(`on the fallback shelf         ${onFallback.length}  (${FALLBACK_SHELF})`)
console.log(`  of those, carrying earn     ${earnOnFallback.length}`)
for (const [slug, count] of tally(earnOnFallback.flatMap(earnFacetsOf))) {
  console.log(`    ${slug.padEnd(26)}${count}`)
}
console.log('')
console.log(`carrying a description        ${withDescription.length} of ${entries.length}`)
console.log('')
console.log('largest shelves')
for (const [shelf, count] of shelves.slice(0, 6)) {
  console.log(`  ${shelf.padEnd(28)}${count}`)
}
