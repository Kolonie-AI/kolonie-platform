import { describe, expect, it } from 'vitest'
import { ASCII_NAME_MAX_LENGTH, ASCII_NAME_ROWS, asciiName } from './ascii-name.js'

describe('the agent’s name in blocks (#424)', () => {
  it('renders a name the table covers', () => {
    const rendered = asciiName('NOVA')

    expect(rendered).not.toBeNull()
    expect(rendered?.split('\n')).toHaveLength(ASCII_NAME_ROWS)
    expect(rendered).toContain('#')
  })

  /** Lower case is the ordinary case: most names are typed in it. */
  it('reads a lower-case name as the same picture', () => {
    expect(asciiName('nova')).toBe(asciiName('NOVA'))
  })

  it('renders digits, and the three punctuation marks a name usually holds', () => {
    for (const name of ['agent-01', 'a_b', 'v1.2']) {
      expect(asciiName(name), name).not.toBeNull()
    }
  })

  /**
   * The width budget. Past this the block overflows the column, and what an
   * operator would see is a horizontal scrollbar inside an email client's
   * browser — so the page falls back to the plain heading instead.
   */
  it('falls back for a name too wide to fit the column', () => {
    expect(asciiName('A'.repeat(ASCII_NAME_MAX_LENGTH))).not.toBeNull()
    expect(asciiName('A'.repeat(ASCII_NAME_MAX_LENGTH + 1))).toBeNull()
    // A name may be 64 characters, and that is the case this exists for.
    expect(asciiName('A'.repeat(64))).toBeNull()
  })

  /**
   * The character set. A name carries anything at all — the Colony puts no
   * character rule on it — and every script on earth is not a table anybody
   * maintains by hand.
   */
  it('falls back for a character the table does not cover', () => {
    for (const name of ['ハル', 'café', 'ædel', '<script>', 'a&b']) {
      expect(asciiName(name), name).toBeNull()
    }
  })

  /**
   * The escaping question, answered by construction rather than by remembering
   * to call `escape`: the output is `#`, spaces and newlines, and a name holding
   * anything that could open a tag has no glyph and never reaches it.
   */
  it('emits nothing but blocks, spaces and newlines', () => {
    expect(asciiName('KOLONIE')).toMatch(/^[#\n ]+$/)
  })

  /** Five empty lines above a heading is a gap, not a decoration. */
  it('falls back for a name that is only spaces', () => {
    expect(asciiName('   ')).toBeNull()
    expect(asciiName('')).toBeNull()
  })
})
