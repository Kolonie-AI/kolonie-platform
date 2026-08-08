import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONSOLE_STYLE, CONSOLE_TOKENS } from './theme.js'
import { page } from './html.js'

/**
 * What holds the console's palette together (`#422`).
 *
 * Two halves, and neither covers the other. **This file is the local half**: a
 * colour written into a rule instead of taken from a token, a token used and
 * never declared, an external asset smuggled in past the CSP. **The other half
 * is `scripts/check-theme-drift.mjs`**, which compares the values themselves
 * with `kolonie-website`'s and needs that repository in hand, so it runs as a
 * job rather than here.
 */

const source = readFileSync(fileURLToPath(new URL('./theme.ts', import.meta.url)), 'utf8')

/**
 * The stylesheet with the `:root` block cut out and the comments removed — the
 * rules, and nothing that only reads like one.
 *
 * Comments go because an issue reference is `#423`, which is a valid hex colour
 * to a regular expression and is not one to anybody else. The alternative was
 * writing the rules with no reasoning in them, which is the wrong thing to trade
 * for a simpler test.
 */
const rules = CONSOLE_STYLE.slice(CONSOLE_STYLE.indexOf('}') + 1).replaceAll(
  /\/\*[\s\S]*?\*\//g,
  '',
)

describe('the console stylesheet', () => {
  /**
   * The rule the website enforces from its own side: a colour value in a page
   * is a colour the palette does not know about, and it is how the two ended up
   * needing this issue in the first place.
   */
  it('writes no colour literal outside the token block', () => {
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(rules).not.toMatch(/\b(?:hsla?|rgba?|oklch|color-mix)\(/)
  })

  it('declares every token it uses', () => {
    const used = new Set([...rules.matchAll(/var\((--k-[a-z0-9-]+)\)/g)].map(([, name]) => name))
    expect(used.size).toBeGreaterThan(10)

    const declared = new Set(CONSOLE_STYLE.match(/(--k-[a-z0-9-]+):/g)?.map((d) => d.slice(0, -1)))
    for (const token of used) expect(declared).toContain(token)
  })

  /**
   * Dark only, and stated rather than inherited. `color-scheme: light dark` was
   * the old sheet's first line and it bought two appearances nobody had ever
   * looked at — the light one being the browser's defaults on a page with no
   * colours of its own.
   */
  it('is dark and not both', () => {
    expect(CONSOLE_STYLE).toContain('color-scheme: dark')
    expect(CONSOLE_STYLE).not.toContain('light dark')
  })

  /**
   * The CSP is `default-src 'none'` with `img-src 'self'`, and the reason the
   * console can keep it that strict is that nothing here fetches anything. A
   * `url(…)` or an `@import` in the stylesheet would be the first thing to
   * quietly need it relaxed.
   */
  it('fetches nothing', () => {
    expect(CONSOLE_STYLE).not.toMatch(/url\(/)
    expect(CONSOLE_STYLE).not.toMatch(/@(?:import|font-face)/)
  })

  it('reaches a rendered page', () => {
    const rendered = page({ title: 'A page', body: '<h1>A page</h1>' })
    expect(rendered).toContain('--k-bg: hsl(200 14% 7%)')
    expect(rendered).toContain('background: var(--k-bg)')
  })
})

describe('the tokens the drift check compares', () => {
  it('covers the ground, the ramp, the accent and the five semantic colours', () => {
    for (const token of [
      '--k-bg',
      '--k-surface',
      '--k-hairline',
      '--k-text',
      '--k-text-strong',
      '--k-text-muted',
      '--k-text-faint',
      '--k-accent',
      '--k-note',
      '--k-tip',
      '--k-caution',
      '--k-danger',
      '--k-good',
    ]) {
      expect(CONSOLE_TOKENS).toHaveProperty(token)
    }
  })

  /**
   * `check-theme-drift.mjs` reads this file as text rather than importing it,
   * so that a check about two text files does not need a compiler. That makes
   * the *shape* of the declaration load-bearing, which is exactly the kind of
   * coupling that breaks silently — so it is asserted here, where the failure
   * says what it is instead of a job reporting zero tokens compared.
   */
  it('is written in the literal shape the drift check parses', () => {
    const block = source.match(
      /export const CONSOLE_TOKENS: Readonly<Record<string, string>> = \{([\s\S]*?)\n\}/,
    )
    expect(block).not.toBeNull()

    const parsed = new Map(
      [...(block?.[1] ?? '').matchAll(/'(--k-[a-z0-9-]+)':\s*'([^']*)'/g)].map(
        ([, name, value]) => [name, value] as const,
      ),
    )
    expect(Object.fromEntries(parsed)).toEqual(CONSOLE_TOKENS)
  })

  /**
   * The font stack is the one token that is deliberately *not* the website's —
   * it self-hosts JetBrains Mono and this page cannot fetch a file. Keeping it
   * out of `CONSOLE_TOKENS` is what keeps the drift check honest, because a
   * token in there is a token that must match.
   */
  it('leaves the font stack out, because it is not shared', () => {
    expect(CONSOLE_TOKENS).not.toHaveProperty('--k-font-mono')
    expect(CONSOLE_STYLE).toContain('--k-font-mono:')
    expect(CONSOLE_STYLE).not.toContain('JetBrains')
  })
})

/**
 * Two widths, and neither is doing the other's job (`#584`).
 *
 * `kolonie-website#81` split them on the site and argued it there: a prose
 * measure caps a *line* so the eye does not lose its place; a container caps the
 * *composition* so a page at a width nobody designed for is arranged on a field
 * rather than stretched across one. The console never received that change,
 * because it has its own stylesheet in its own repository — so until this it
 * rendered at 736px beside the site's 1280px, and a person signing in appeared
 * to change products.
 */
describe('the console’s two widths', () => {
  it('composes at the same width the site does', () => {
    expect(CONSOLE_TOKENS['--k-container']).toBe('80rem')
    expect(rules).toMatch(/max-width:\s*var\(--k-container\)/)
  })

  /** The number `#584` was measured against. It must not come back by hand. */
  it('caps nothing at 46rem any more', () => {
    expect(CONSOLE_STYLE).not.toContain('46rem')
  })

  it('still caps running text at the prose measure', () => {
    expect(CONSOLE_TOKENS['--k-measure']).toBe('68ch')
    expect(rules).toMatch(/\bp\s*\{[^}]*max-width:\s*var\(--k-measure\)/)
    expect(rules).toMatch(/ul:not\(\[class\]\)[^{]*\{[^}]*max-width:\s*var\(--k-measure\)/)
  })

  /**
   * The tables are what the change is for: the queue, the wish list and the
   * quests table were squeezed into a paragraph's width by one number doing two
   * jobs.
   */
  it('lets a table take the whole composition', () => {
    expect(rules).toMatch(/\btable\s*\{[^}]*width:\s*100%/)
    expect(rules).not.toMatch(/\btable\s*\{[^}]*max-width:\s*var\(--k-measure\)/)
  })

  /**
   * And the one place the prose measure does a layout job on purpose: a text
   * field 1280px long is not a better text field.
   */
  it('keeps a text field to a length somebody can read back', () => {
    expect(rules).toMatch(/input,\s*textarea\s*\{[^}]*max-width:\s*var\(--k-measure\)/)
  })
})
