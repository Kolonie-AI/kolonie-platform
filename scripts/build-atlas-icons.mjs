#!/usr/bin/env node
/**
 * The Atlas icon set, generated from Font Awesome Free (`#1409`).
 *
 * Usage:
 *   node scripts/build-atlas-icons.mjs            # write apps/api/src/atlas/icons.ts
 *   node scripts/build-atlas-icons.mjs --check    # fail if the file has drifted
 *
 * ## The decision this file is
 *
 * `#1409` asked for **one** icon system and offered two: a self-hosted Font
 * Awesome subset, or a token SVG sprite drawn here. `#1332` had already shipped
 * the second — seven marks drawn by hand — and the argument for it was about
 * bytes: measured on the live Atlas index on 2026-08-22, thirty-seven icon
 * occurrences of seven distinct marks cost **612 bytes gzipped**, because gzip
 * collapses a repeated string to almost nothing.
 *
 * **That measurement answered the wrong question.** What the drawn set costs is
 * not bandwidth, it is that every icon after the seventh has to be invented — a
 * shape argued about, drawn at 16 px, and reviewed by somebody who is not a
 * designer. Font Awesome has two thousand of them already. That is the operator's
 * reason and it is the one that decided this.
 *
 * ## What is taken, and what is not
 *
 * **The path data, and nothing else.** No font file, no stylesheet, no CDN, no
 * runtime loader — so the CSP is unchanged and `font-src` stays closed, which is
 * the one thing `#1332` was right about and worth keeping. Each icon is inlined
 * exactly as it is drawn today, with `fill="currentColor"` as Font Awesome ships
 * it, so a mark still takes the colour of the chip it sits in.
 *
 * The package is a **devDependency**: it is a source of shapes at build time and
 * nothing at runtime depends on it.
 *
 * **Moving to the webfont later is a delivery change and not an icon change.**
 * The names below would not move. That is the whole reason to generate rather
 * than paste.
 *
 * ## Adding the ninth icon
 *
 * Add a line to {@link SUBSET} and run this. Do not draw anything.
 *
 * ## Attribution
 *
 * Font Awesome Free icons are CC BY 4.0, which requires attribution — it is in
 * `NOTICE`, and the generated file carries it too so that a reader of the icons
 * sees it without going looking.
 */
// `console` and `process` are imported rather than reached for, as
// `build-decisions-index.mjs` and `check-counts.mjs` do: the eslint config
// declares no environment for a script.
import console from 'node:console'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FA = join(ROOT, 'node_modules/@fortawesome/fontawesome-free/svgs')
const TARGET = join(ROOT, 'apps/api/src/atlas/icons.ts')

/**
 * **The subset, and the whole of it.** The left column is what the Atlas calls
 * the fact; the right is the Font Awesome name. They are separate on purpose:
 * `refused` is a finding this catalogue makes, and `door-closed` is a drawing —
 * a call site should read the claim, not the picture.
 *
 * The names carried over from `#1332` unchanged, so every existing call site is
 * untouched by this change and the diff is the shapes.
 */
const SUBSET = [
  ['measured', 'solid/ruler-horizontal', 'Walked, and no route written: a ruler, not a verdict.'],
  ['joinable', 'solid/circle-check', 'A route exists: the check every catalogue uses.'],
  [
    'refused',
    'solid/door-closed',
    'A closed door, and deliberately not a cross: a refusal is a finding.',
  ],
  ['wall', 'solid/road-barrier', 'Something stood in the way.'],
  ['earn', 'solid/coins', 'It pays.'],
  ['dual-use', 'solid/circle-half-stroke', 'Worth holding and a way to earn: it is two things.'],
  ['homepage', 'solid/arrow-up-right-from-square', 'Where it lives: an arrow leaving the box.'],
  [
    'question',
    'solid/circle-question',
    'A question somebody actually asked. `#1409` asked for the FAQ headers.',
  ],
]

/** The `d` attribute and the `viewBox`, which is all that travels. */
function shapeOf(icon) {
  const svg = readFileSync(join(FA, `${icon}.svg`), 'utf8')
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1])

  if (viewBox === undefined || paths.length === 0) {
    throw new Error(`${icon}: no viewBox or no path — the package layout changed`)
  }
  return { viewBox, paths }
}

const ATTRIBUTION =
  'Font Awesome Free 7.3.1 by @fontawesome — https://fontawesome.com — icons CC BY 4.0'

/**
 * **The viewBox travels with the mark, because Font Awesome's are not square.**
 * The hand-drawn set `#1332` shipped was seven `0 0 16 16` boxes and could share
 * one wrapper; these are 448, 512, 576 and 640 wide against a height of 512. A
 * shared wrapper would squash four of the eight, so the width is emitted as the
 * aspect ratio in `em` and the height stays at `1em` — a mark is still exactly
 * as tall as the word beside it, which is the only rule that matters here.
 */
const entries = SUBSET.map(([name, icon, why]) => {
  const { viewBox, paths } = shapeOf(icon)
  const [, , w, h] = viewBox.split(/\s+/).map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h) || h === 0) {
    throw new Error(`${icon}: viewBox "${viewBox}" is not a box`)
  }
  const d = paths.map((p) => `<path d="${p}"/>`).join('')
  return { name, icon, why, viewBox, width: (w / h).toFixed(3).replace(/\.?0+$/, ''), d }
})

const heights = [...new Set(entries.map((e) => e.viewBox.split(/\s+/)[3]))]
if (heights.length !== 1) {
  throw new Error(
    `the subset spans ${heights.length} viewBox heights (${heights.join(', ')}); ` +
      'the width-from-ratio rule assumes one, so the wrapper would have to change',
  )
}

const body = entries
  .map(
    (e) =>
      `  /** ${e.why} */\n` +
      `  /* ${e.icon} */\n` +
      `  '${e.name}': mark('${e.viewBox}', '${e.width}', '${e.d}'),`,
  )
  .join('\n')

const file = `/**
 * The Atlas icon set — **generated, do not edit** (\`#1409\`).
 *
 * Written by \`scripts/build-atlas-icons.mjs\` from Font Awesome Free, which is a
 * devDependency and a source of shapes at build time. Nothing at runtime
 * depends on it: what ships is the path data below, inline.
 *
 * **To add an icon, add a line to \`SUBSET\` in that script and run
 * \`npm run build:atlas-icons\`.** Do not draw one. That is the whole reason
 * \`#1409\` chose a library over the seven marks \`#1332\` drew by hand — bytes were
 * never the problem (612 gzipped for thirty-seven occurrences, measured
 * 2026-08-22); inventing the eighth was.
 *
 * ## No font file, and the CSP is unchanged
 *
 * Only the \`d\` attributes are taken. No webfont, no stylesheet, no CDN and no
 * runtime loader, so \`font-src\` stays closed — the one thing \`#1332\` was right
 * about and worth keeping. Moving to the webfont later would change delivery and
 * not a single name here.
 *
 * ## Never icon-only, and that is the whole accessibility rule
 *
 * \`#1326\` decision 7: an icon always sits beside its own text label. Every mark
 * is \`aria-hidden\` and \`focusable="false"\` — decoration next to a word that
 * already says the thing. **A caller that cannot put a label next to one should
 * not use one**, which is why nothing here takes a title or a label argument: the
 * API makes the correct use the only use.
 *
 * ## The colours are the chip's
 *
 * Every path is \`currentColor\`, so a mark inside \`.k-refused\` is the caution
 * colour and the same mark inside \`.k-atlas-earn\` is the note colour, with
 * nothing here knowing either. That keeps the palette in \`theme.ts\`.
 *
 * ${ATTRIBUTION}
 */

/**
 * One mark, as tall as the text it sits beside.
 *
 * The width follows the icon's own aspect ratio rather than being forced square:
 * Font Awesome draws at four different widths against one height, and forcing
 * \`1em × 1em\` would squash half the set.
 */
function mark(viewBox: string, width: string, path: string): string {
  return (
    \`<svg class="k-icon" viewBox="\${viewBox}" width="\${width}em" height="1em" \` +
    'aria-hidden="true" focusable="false" fill="currentColor">' +
    path +
    '</svg>'
  )
}

/** The subset, by what it marks rather than by what it looks like. */
export const ATLAS_ICONS = {
${body}
} as const satisfies Readonly<Record<string, string>>

export type AtlasIcon = keyof typeof ATLAS_ICONS

/** One mark by name, or nothing for a name that has none. */
export function atlasIcon(name: AtlasIcon): string {
  return ATLAS_ICONS[name]
}
`

if (process.argv.includes('--check')) {
  const onDisk = readFileSync(TARGET, 'utf8')
  if (onDisk !== file) {
    console.error(
      'apps/api/src/atlas/icons.ts is not what the subset would produce. ' +
        'Run `npm run build:atlas-icons` and commit the result.',
    )
    process.exit(1)
  }
  console.log(`atlas icons: ${entries.length} marks, generated file matches the subset`)
} else {
  writeFileSync(TARGET, file)
  console.log(`apps/api/src/atlas/icons.ts written: ${entries.length} marks from Font Awesome Free`)
}
