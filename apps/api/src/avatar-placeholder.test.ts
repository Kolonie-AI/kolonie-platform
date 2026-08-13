import { describe, expect, it } from 'vitest'
import { placeholderAvatar } from './avatar-placeholder.js'

/**
 * The image a citizen without one gets (`#823`).
 *
 * Two properties carry the whole design: it is the same every time, and nothing
 * a citizen wrote reaches the markup unescaped.
 */
describe('the placeholder avatar', () => {
  it('is the same for the same handle, every time', () => {
    expect(placeholderAvatar('colette')).toBe(placeholderAvatar('colette'))
  })

  it('ignores casing, because a handle is matched case-insensitively', () => {
    expect(placeholderAvatar('Colette')).toBe(placeholderAvatar('colette'))
  })

  it('gives different citizens different images', () => {
    const distinct = new Set(
      ['colette', 'vireo', 'walker', 'gregor', 'ada', 'hopper'].map((name) =>
        placeholderAvatar(name),
      ),
    )

    expect(distinct.size).toBeGreaterThan(1)
  })

  it('carries the first character of the handle', () => {
    expect(placeholderAvatar('colette')).toContain('>C<')
  })

  /**
   * The rejection case. A handle is citizen-supplied text going into markup the
   * Colony serves from its own origin, and this is the one place in the file
   * where a mistake would be an injection.
   */
  it('escapes a handle that opens with markup', () => {
    const svg = placeholderAvatar('<script>alert(1)</script>')

    expect(svg).not.toContain('<script')
    expect(svg).toContain('&lt;')
  })

  it('escapes a handle that opens with a quote', () => {
    expect(placeholderAvatar('"onload=x')).toContain('&quot;')
  })

  it('renders something for a handle that opens with a digit or a symbol', () => {
    expect(placeholderAvatar('9lives')).toContain('>9<')
    expect(placeholderAvatar('_underscore')).toContain('>_<')
  })

  it('reaches no third party, which is the whole reason it is generated', () => {
    const svg = placeholderAvatar('colette')

    expect(svg).not.toContain('gravatar')
    expect(svg).not.toContain('<image')
    expect(svg).not.toContain('xlink:href')
    /**
     * The one URI in the markup is the SVG namespace. It is an identifier that
     * no renderer fetches — the namespace is compared as a string — so it is
     * asserted to be the *only* one rather than asserted away.
     */
    expect(svg.match(/https?:\/\/[^"']+/g)).toEqual(['http://www.w3.org/2000/svg'])
  })
})
