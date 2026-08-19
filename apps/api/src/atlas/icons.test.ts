import { describe, expect, it } from 'vitest'
import { ATLAS_ICONS, atlasIcon } from './icons.js'

/**
 * The seven marks, and the three properties that make them safe to put on a
 * public page with no script (`#1332`).
 *
 * **Asserted over the whole set rather than one of them**, because each property
 * is a rule about the set: an eighth mark added without `aria-hidden` is exactly
 * the mistake this file exists to catch, and a test naming one icon would not.
 */
describe('the marks an Atlas page draws beside its labels', () => {
  const every = Object.values(ATLAS_ICONS)

  it('draws the seven the frozen set names', () => {
    expect(Object.keys(ATLAS_ICONS).sort()).toEqual([
      'dual-use',
      'earn',
      'homepage',
      'joinable',
      'measured',
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
      expect(icon).toContain('stroke="currentColor"')
      expect(icon).toContain('fill="none"')
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

  it('sizes every mark to the text it sits beside', () => {
    for (const icon of every) {
      expect(icon).toContain('width="1em"')
      expect(icon).toContain('height="1em"')
    }
  })

  it('answers by name', () => {
    expect(atlasIcon('earn')).toBe(ATLAS_ICONS.earn)
  })
})
