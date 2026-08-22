/**
 * The Atlas icon set — **generated, do not edit** (`#1409`).
 *
 * Written by `scripts/build-atlas-icons.mjs` from Font Awesome Free, which is a
 * devDependency and a source of shapes at build time. Nothing at runtime
 * depends on it: what ships is the path data below, inline.
 *
 * **To add an icon, add a line to `SUBSET` in that script and run
 * `npm run build:atlas-icons`.** Do not draw one. That is the whole reason
 * `#1409` chose a library over the seven marks `#1332` drew by hand — bytes were
 * never the problem (612 gzipped for thirty-seven occurrences, measured
 * 2026-08-22); inventing the eighth was.
 *
 * ## No font file, and the CSP is unchanged
 *
 * Only the `d` attributes are taken. No webfont, no stylesheet, no CDN and no
 * runtime loader, so `font-src` stays closed — the one thing `#1332` was right
 * about and worth keeping. Moving to the webfont later would change delivery and
 * not a single name here.
 *
 * ## Never icon-only, and that is the whole accessibility rule
 *
 * `#1326` decision 7: an icon always sits beside its own text label. Every mark
 * is `aria-hidden` and `focusable="false"` — decoration next to a word that
 * already says the thing. **A caller that cannot put a label next to one should
 * not use one**, which is why nothing here takes a title or a label argument: the
 * API makes the correct use the only use.
 *
 * ## The colours are the chip's
 *
 * Every path is `currentColor`, so a mark inside `.k-refused` is the caution
 * colour and the same mark inside `.k-atlas-earn` is the note colour, with
 * nothing here knowing either. That keeps the palette in `theme.ts`.
 *
 * Font Awesome Free 7.3.1 by @fontawesome — https://fontawesome.com — icons CC BY 4.0
 */

/**
 * One mark, as tall as the text it sits beside.
 *
 * The width follows the icon's own aspect ratio rather than being forced square:
 * Font Awesome draws at four different widths against one height, and forcing
 * `1em × 1em` would squash half the set.
 */
function mark(viewBox: string, width: string, path: string): string {
  return (
    `<svg class="k-icon" viewBox="${viewBox}" width="${width}em" height="1em" ` +
    'aria-hidden="true" focusable="false" fill="currentColor">' +
    path +
    '</svg>'
  )
}

/** The subset, by what it marks rather than by what it looks like. */
export const ATLAS_ICONS = {
  /** Walked, and no route written: a ruler, not a verdict. */
  /* solid/ruler-horizontal */
  'measured': mark('0 0 576 512', '1.125', '<path d="M48 384c-26.5 0-48-21.5-48-48L0 176c0-26.5 21.5-48 48-48l24 0 0 104c0 13.3 10.7 24 24 24s24-10.7 24-24l0-104 48 0 0 72c0 13.3 10.7 24 24 24s24-10.7 24-24l0-72 48 0 0 104c0 13.3 10.7 24 24 24s24-10.7 24-24l0-104 48 0 0 72c0 13.3 10.7 24 24 24s24-10.7 24-24l0-72 48 0 0 104c0 13.3 10.7 24 24 24s24-10.7 24-24l0-104 24 0c26.5 0 48 21.5 48 48l0 160c0 26.5-21.5 48-48 48L48 384z"/>'),
  /** A route exists: the check every catalogue uses. */
  /* solid/circle-check */
  'joinable': mark('0 0 512 512', '1', '<path d="M256 512a256 256 0 1 1 0-512 256 256 0 1 1 0 512zM374 145.7c-10.7-7.8-25.7-5.4-33.5 5.3L221.1 315.2 169 263.1c-9.4-9.4-24.6-9.4-33.9 0s-9.4 24.6 0 33.9l72 72c5 5 11.8 7.5 18.8 7s13.4-4.1 17.5-9.8L379.3 179.2c7.8-10.7 5.4-25.7-5.3-33.5z"/>'),
  /** A closed door, and deliberately not a cross: a refusal is a finding. */
  /* solid/door-closed */
  'refused': mark('0 0 448 512', '0.875', '<path d="M32 64C32 28.7 60.7 0 96 0L352 0c35.3 0 64 28.7 64 64l0 384c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 512c-17.7 0-32-14.3-32-32s14.3-32 32-32L32 64zM320 288a32 32 0 1 0 0-64 32 32 0 1 0 0 64z"/>'),
  /** Something stood in the way. */
  /* solid/road-barrier */
  'wall': mark('0 0 640 512', '1.25', '<path d="M32 32C14.3 32 0 46.3 0 64L0 448c0 17.7 14.3 32 32 32s32-14.3 32-32L64 266.3 149.2 96 64 96 64 64c0-17.7-14.3-32-32-32zM405.2 96l-74.3 0-5.4 10.7-90.6 181.3 74.3 0 5.4-10.7 90.6-181.3zM362.8 288l74.3 0 5.4-10.7 90.6-181.3-74.3 0-5.4 10.7-90.6 181.3zM202.8 96l-5.4 10.7-90.6 181.3 74.3 0 5.4-10.7 90.6-181.3-74.3 0zm288 192l85.2 0 0 160c0 17.7 14.3 32 32 32s32-14.3 32-32l0-384c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 53.7-85.2 170.3z"/>'),
  /** It pays. */
  /* solid/coins */
  'earn': mark('0 0 512 512', '1', '<path d="M128 96l0-16c0-44.2 86-80 192-80S512 35.8 512 80l0 16c0 30.6-41.3 57.2-102 70.7-2.4-2.8-4.9-5.5-7.4-8-15.5-15.3-35.5-26.9-56.4-35.5-41.9-17.5-96.5-27.1-154.2-27.1-21.9 0-43.3 1.4-63.8 4.1-.2-1.3-.2-2.7-.2-4.1zM432 353l0-46.2c15.1-3.9 29.3-8.5 42.2-13.9 13.2-5.5 26.1-12.2 37.8-20.3l0 15.4c0 26.8-31.5 50.5-80 65zm0-96l0-33c0-4.5-.4-8.8-1-13 15.5-3.9 30-8.6 43.2-14.2s26.1-12.2 37.8-20.3l0 15.4c0 26.8-31.5 50.5-80 65zM0 240l0-16c0-44.2 86-80 192-80s192 35.8 192 80l0 16c0 44.2-86 80-192 80S0 284.2 0 240zm384 96c0 44.2-86 80-192 80S0 380.2 0 336l0-15.4c11.6 8.1 24.5 14.7 37.8 20.3 41.9 17.5 96.5 27.1 154.2 27.1s112.3-9.7 154.2-27.1c13.2-5.5 26.1-12.2 37.8-20.3l0 15.4zm0 80.6l0 15.4c0 44.2-86 80-192 80S0 476.2 0 432l0-15.4c11.6 8.1 24.5 14.7 37.8 20.3 41.9 17.5 96.5 27.1 154.2 27.1s112.3-9.7 154.2-27.1c13.2-5.5 26.1-12.2 37.8-20.3z"/>'),
  /** Worth holding and a way to earn: it is two things. */
  /* solid/circle-half-stroke */
  'dual-use': mark('0 0 512 512', '1', '<path d="M448 256c0-106-86-192-192-192l0 384c106 0 192-86 192-192zM0 256a256 256 0 1 1 512 0 256 256 0 1 1 -512 0z"/>'),
  /** Where it lives: an arrow leaving the box. */
  /* solid/arrow-up-right-from-square */
  'homepage': mark('0 0 512 512', '1', '<path d="M320 0c-17.7 0-32 14.3-32 32s14.3 32 32 32l82.7 0-201.4 201.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L448 109.3 448 192c0 17.7 14.3 32 32 32s32-14.3 32-32l0-160c0-17.7-14.3-32-32-32L320 0zM80 96C35.8 96 0 131.8 0 176L0 432c0 44.2 35.8 80 80 80l256 0c44.2 0 80-35.8 80-80l0-80c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 80c0 8.8-7.2 16-16 16L80 448c-8.8 0-16-7.2-16-16l0-256c0-8.8 7.2-16 16-16l80 0c17.7 0 32-14.3 32-32s-14.3-32-32-32L80 96z"/>'),
  /** A question somebody actually asked. `#1409` asked for the FAQ headers. */
  /* solid/circle-question */
  'question': mark('0 0 512 512', '1', '<path d="M256 512a256 256 0 1 0 0-512 256 256 0 1 0 0 512zm0-336c-17.7 0-32 14.3-32 32 0 13.3-10.7 24-24 24s-24-10.7-24-24c0-44.2 35.8-80 80-80s80 35.8 80 80c0 47.2-36 67.2-56 74.5l0 3.8c0 13.3-10.7 24-24 24s-24-10.7-24-24l0-8.1c0-20.5 14.8-35.2 30.1-40.2 6.4-2.1 13.2-5.5 18.2-10.3 4.3-4.2 7.7-10 7.7-19.6 0-17.7-14.3-32-32-32zM224 368a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z"/>'),
} as const satisfies Readonly<Record<string, string>>

export type AtlasIcon = keyof typeof ATLAS_ICONS

/** One mark by name, or nothing for a name that has none. */
export function atlasIcon(name: AtlasIcon): string {
  return ATLAS_ICONS[name]
}
