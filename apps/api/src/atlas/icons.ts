/**
 * The Atlas icon set: seven marks, inline, decorative (`#1332`).
 *
 * ## Why they are inline SVG and not anything else
 *
 * **Atlas pages carry no script** — that is the CSP, and `searchBox` is already
 * written as a `GET` form for the same reason. An icon font needs a font file,
 * an `<img>` needs a request per glyph and cannot take `currentColor`, and a
 * sprite sheet needs a second document. Seven paths of a few dozen bytes each,
 * written into the markup, need none of those and inherit the chip's colour for
 * free.
 *
 * ## Never icon-only, and that is the whole accessibility rule
 *
 * `#1326` decision 7: an icon always sits beside its own text label. So every
 * mark here is `aria-hidden` and `focusable="false"` — it is decoration next to
 * a word that already says the thing, and a screen reader that announced *image*
 * beside *cannot be joined* would be reading the page twice. **A caller that
 * cannot put a label next to one should not use one**, which is why nothing here
 * takes a title or a label argument: the API makes the correct use the only use.
 *
 * ## Why they are drawn rather than imported
 *
 * The shapes are deliberately crude — a circle, a check, a bar, a coin — because
 * they are read at 1em beside a word they cannot contradict. An icon library
 * would be a dependency, a licence and a build step for something a reader
 * perceives as *there is a mark here*, and `#1326` decision 7 refuses an
 * illustration framework by name.
 *
 * ## The colours are the chip's
 *
 * Every path is `stroke="currentColor"` with no fill, so a mark inside
 * `.k-refused` is the caution colour and the same mark inside `.k-atlas-earn` is
 * the note colour, with nothing here knowing either. That is what keeps the
 * palette in `theme.ts` — `#1326` decision 7 again — and what stops a mark
 * disagreeing with the word beside it.
 */

/** One mark, at the size of the text it sits beside. */
function mark(path: string): string {
  return (
    '<svg class="k-icon" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" ' +
    'focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5" ' +
    `stroke-linecap="round" stroke-linejoin="round">${path}</g></svg>`
  )
}

/**
 * The seven, by what they mark rather than by what they look like.
 *
 * Named for the fact so that a reader of a call site sees the claim being made.
 * `measured` and `joinable` are separate marks because they are the two states a
 * reader most needs to tell apart at a glance — walked-and-no-route against a
 * route that exists — and giving them one mark in two colours would put the
 * whole distinction on the colour.
 */
export const ATLAS_ICONS = {
  /** Walked, and no route written: a ruler's tick, not a verdict. */
  measured: mark('<path d="M2 11h12"/><path d="M5 11V8"/><path d="M8 11V6"/><path d="M11 11V9"/>'),
  /** A route exists: the check every catalogue uses and no reader has to learn. */
  joinable: mark('<path d="M3 8.5l3.5 3.5L13 5"/>'),
  /** A closed door, and deliberately not a cross: a refusal is a finding. */
  refused: mark('<path d="M4 3h8v10H4z"/><path d="M9.5 8h.01"/>'),
  /** Something stood in the way: a bar across the path. */
  wall: mark('<path d="M2 6h12"/><path d="M2 10h12"/><path d="M6 3v10"/><path d="M10 3v10"/>'),
  /** It pays: a coin, which is the one shape money has at this size. */
  earn: mark('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v6"/><path d="M6.5 6.5h3"/>'),
  /** Worth holding and a way to earn: two rings, because it is two things. */
  'dual-use': mark('<circle cx="6" cy="8" r="3.5"/><circle cx="10" cy="8" r="3.5"/>'),
  /** Where it lives: an arrow leaving the box. */
  homepage: mark('<path d="M7 3H3v10h10V9"/><path d="M9.5 2.5H14V7"/><path d="M14 2.5L7.5 9"/>'),
} as const satisfies Readonly<Record<string, string>>

export type AtlasIcon = keyof typeof ATLAS_ICONS

/** One mark by name, or nothing for a name that has none. */
export function atlasIcon(name: AtlasIcon): string {
  return ATLAS_ICONS[name]
}
