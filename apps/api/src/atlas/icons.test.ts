import { describe, expect, it } from 'vitest'
import { ATLAS_ICONS, atlasIcon } from './icons.js'

/**
 * The marks, and the properties that make them safe to put on a public page with
 * no script (`#1332`, and the set itself since `#1409`).
 *
 * **Asserted over the whole set rather than one of them**, because each property
 * is a rule about the set: a ninth mark added without `aria-hidden` is exactly
 * the mistake this file exists to catch, and a test naming one icon would not.
 *
 * **What `#1409` changed and what it did not.** The shapes now come from Font
 * Awesome Free rather than being drawn here, so they are filled where they used
 * to be stroked and they are not all square. Every rule below about *what a mark
 * may do on the page* is untouched, and that is the point: the source of the
 * drawing moved and the contract did not.
 */
describe('the marks an Atlas page draws beside its labels', () => {
  const every = Object.values(ATLAS_ICONS)

  it('draws the set the subset names', () => {
    expect(Object.keys(ATLAS_ICONS).sort()).toEqual([
      'dual-use',
      'earn',
      'homepage',
      'joinable',
      'measured',
      'question',
      'refused',
      'wall',
    ])
  })

  /**
   * **Decoration beside a word that already says the thing** (`#1326`
   * decision 7). A screen reader announcing *image* next to *cannot be joined*
   * would be reading the page twice, and `focusable="false"` is what keeps the
   * mark out of the tab order in the browsers that put SVG in it by default.
   */
  it('hides every mark from a reader that is not looking at it', () => {
    for (const icon of every) {
      expect(icon).toContain('aria-hidden="true"')
      expect(icon).toContain('focusable="false"')
      /** Never a label of its own: the text beside it is the label. */
      expect(icon).not.toContain('<title>')
      expect(icon).not.toContain('aria-label')
    }
  })

  /**
   * **The colour comes from the chip and never from here** (`#1326` decision 7,
   * which refuses a palette of its own). A mark inside `.k-refused` is the
   * caution colour and the same mark inside `.k-atlas-earn` is the note colour,
   * with nothing in this file knowing either.
   */
  it('takes its colour from whatever it is inside', () => {
    for (const icon of every) {
      /**
       * `fill` since `#1409` and `stroke` before it: Font Awesome draws filled
       * shapes where the hand-drawn set drew outlines. What matters is unchanged
       * — the value is `currentColor` and never a colour of its own.
       */
      expect(icon).toContain('fill="currentColor"')
      /** No literal colour anywhere: not a hex, not a token, not a name. */
      expect(icon).not.toMatch(/#[0-9a-f]{3,6}/i)
      expect(icon).not.toContain('var(--')
    }
  })

  /**
   * **Atlas pages carry no script**, which is the CSP and the reason these are
   * inline SVG rather than an icon font or a sprite. A mark that smuggled a
   * handler or a remote reference in would take the whole page's guarantee with
   * it.
   */
  it('carries no script, no handler and no request', () => {
    for (const icon of every) {
      expect(icon).not.toContain('<script')
      expect(icon).not.toMatch(/\son[a-z]+=/i)
      expect(icon).not.toContain('href')
      expect(icon).not.toContain('url(')
    }
  })

  /**
   * **As tall as the word, and never squashed** (`#1409`). Font Awesome draws at
   * four widths against one height, so forcing `1em × 1em` would flatten half
   * the set. The height is the rule — a mark is exactly as tall as the text it
   * sits beside — and the width follows the icon's own aspect ratio.
   */
  it('sizes every mark to the text it sits beside', () => {
    for (const icon of every) {
      expect(icon).toContain('height="1em"')
      expect(icon).toMatch(/width="[0-9.]+em"/)
    }
  })

  /**
   * The width is the viewBox's own ratio and not a number somebody typed. A mark
   * whose two disagreed would be the one distortion this rule exists to stop.
   */
  it('takes its width from its own viewBox', () => {
    for (const icon of every) {
      const box = icon.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/)
      const width = icon.match(/width="([0-9.]+)em"/)
      expect(box).not.toBeNull()
      expect(width).not.toBeNull()
      if (box === null || width === null) continue
      expect(Number(width[1])).toBeCloseTo(Number(box[1]) / Number(box[2]), 3)
    }
  })

  it('answers by name', () => {
    expect(atlasIcon('earn')).toBe(ATLAS_ICONS.earn)
  })
})
