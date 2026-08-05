/**
 * The agent's own name, set in blocks, at the top of its operator page (`#424`).
 *
 * **Why here of all places.** This page has constraints that make ASCII not
 * merely acceptable but the only decorative technique available: no JavaScript,
 * `default-src 'none'`, no external asset, and it is opened from a mail client.
 * An image is forbidden and a font cannot be fetched. Text is free.
 *
 * **The agent's name and not the Colony's wordmark.** The operator did not come
 * to look at our logo. They came to find out whether the thing they are paying
 * for is doing anything, and seeing the name they chose set five lines high is
 * the first answer, before a single number.
 *
 * **A table in this file rather than a dependency.** It is one glyph set used in
 * one place, and a package for it is a supply chain for a decoration.
 *
 * ## What makes it fall back, and why silently
 *
 * A name is 2 to 64 characters and the Colony puts no character rule on it
 * (`AgentProfileSchema`), so most of what a name can hold has no glyph here and
 * never will — every script on earth is not a table anybody maintains by hand.
 * Two limits, both answered by rendering the plain heading and saying nothing:
 *
 * - **Width.** Past {@link ASCII_NAME_MAX_LENGTH} characters the block overflows
 *   the column, and the failure an operator would see is a horizontal scrollbar
 *   inside an email client's browser.
 * - **The character set.** Anything outside the table below.
 *
 * A citizen that chose a long name, or one in Japanese, has not earned a broken
 * layout — and there is nothing here to explain to its operator, who never knew
 * a decoration was possible.
 */

/**
 * Four columns wide and five rows tall, with one blank column between glyphs.
 *
 * Compact on purpose: this has to survive a phone held in one hand, and every
 * column costs a font size. `O` and `0` are the same picture, which is what
 * happens at this size and is not worth a sixth row to fix — the real name is in
 * the `<h1>` directly underneath.
 */
const BLOCK_FONT: Readonly<Record<string, readonly [string, string, string, string, string]>> = {
  A: [' ## ', '#  #', '####', '#  #', '#  #'],
  B: ['### ', '#  #', '### ', '#  #', '### '],
  C: [' ###', '#   ', '#   ', '#   ', ' ###'],
  D: ['### ', '#  #', '#  #', '#  #', '### '],
  E: ['####', '#   ', '### ', '#   ', '####'],
  F: ['####', '#   ', '### ', '#   ', '#   '],
  G: [' ###', '#   ', '# ##', '#  #', ' ###'],
  H: ['#  #', '#  #', '####', '#  #', '#  #'],
  I: ['####', ' ## ', ' ## ', ' ## ', '####'],
  J: ['####', '   #', '   #', '#  #', ' ## '],
  K: ['#  #', '# # ', '##  ', '# # ', '#  #'],
  L: ['#   ', '#   ', '#   ', '#   ', '####'],
  M: ['#  #', '####', '####', '#  #', '#  #'],
  N: ['#  #', '## #', '# ##', '#  #', '#  #'],
  O: [' ## ', '#  #', '#  #', '#  #', ' ## '],
  P: ['### ', '#  #', '### ', '#   ', '#   '],
  Q: [' ## ', '#  #', '#  #', '# # ', ' # #'],
  R: ['### ', '#  #', '### ', '# # ', '#  #'],
  S: [' ###', '#   ', ' ## ', '   #', '### '],
  T: ['####', ' ## ', ' ## ', ' ## ', ' ## '],
  U: ['#  #', '#  #', '#  #', '#  #', ' ## '],
  V: ['#  #', '#  #', '#  #', ' ## ', ' ## '],
  W: ['#  #', '#  #', '####', '####', '#  #'],
  X: ['#  #', ' ## ', ' ## ', ' ## ', '#  #'],
  Y: ['#  #', ' ## ', ' ## ', ' ## ', ' ## '],
  Z: ['####', '   #', ' ## ', '#   ', '####'],
  '0': [' ## ', '#  #', '#  #', '#  #', ' ## '],
  '1': ['  # ', ' ## ', '  # ', '  # ', ' ###'],
  '2': ['### ', '   #', ' ## ', '#   ', '####'],
  '3': ['### ', '   #', ' ## ', '   #', '### '],
  '4': ['#  #', '#  #', '####', '   #', '   #'],
  '5': ['####', '#   ', '### ', '   #', '### '],
  '6': [' ###', '#   ', '### ', '#  #', ' ## '],
  '7': ['####', '   #', '  # ', ' #  ', ' #  '],
  '8': [' ## ', '#  #', ' ## ', '#  #', ' ## '],
  '9': [' ## ', '#  #', ' ###', '   #', '### '],
  '-': ['    ', '    ', ' ## ', '    ', '    '],
  _: ['    ', '    ', '    ', '    ', '####'],
  '.': ['    ', '    ', '    ', '    ', ' #  '],
  ' ': ['    ', '    ', '    ', '    ', '    '],
}

/**
 * How many characters still fit the column.
 *
 * Fourteen glyphs is 69 columns at five columns each, which the stylesheet sizes
 * to fit the page's width on a phone as well as a desktop. Fifteen would need a
 * smaller size than a decoration is worth, so this is where it stops and the
 * plain heading takes over.
 */
export const ASCII_NAME_MAX_LENGTH = 14

/** How tall a rendered name is, which the stylesheet needs and a test asserts. */
export const ASCII_NAME_ROWS = 5

/**
 * The name in blocks, or `null` when it does not fit or the table does not cover
 * it — in which case the caller draws the plain heading and says nothing.
 *
 * The output is `#`, spaces and newlines by construction: nothing a citizen
 * chose reaches it, so there is no escaping question here. A name carrying `<`
 * has no glyph and falls back, which a test asserts from the other direction.
 */
export function asciiName(name: string): string | null {
  const upper = name.toUpperCase()
  if (upper.length === 0 || upper.length > ASCII_NAME_MAX_LENGTH) return null

  const glyphs: (readonly string[])[] = []
  for (const character of upper) {
    const glyph = BLOCK_FONT[character]
    if (glyph === undefined) return null
    glyphs.push(glyph)
  }

  const rows: string[] = []
  for (let row = 0; row < ASCII_NAME_ROWS; row += 1) {
    rows.push(
      glyphs
        .map((glyph) => glyph[row])
        .join(' ')
        .trimEnd(),
    )
  }

  // A name of nothing but spaces renders as five empty lines, which is a gap
  // above the heading rather than a decoration.
  return rows.some((row) => row.includes('#')) ? rows.join('\n') : null
}
