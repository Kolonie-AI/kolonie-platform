import { describe, expect, it } from 'vitest'
import {
  providerIconCandidates,
  providerMonogram,
  providerMonogramLetters,
  PROVIDER_ICON_TTL_DAYS,
} from './atlas-icon.js'

/**
 * The pure half of the provider icon (`#1405`).
 *
 * What is asserted here is the two things `#1405` calls decisions: the
 * documented resolution order, and that the failure path draws something rather
 * than nothing. The fetching, the storing and the serving are tested where they
 * live; none of them can be tested without a socket, a database or a server, and
 * all of them depend on these two functions being right.
 */

const BASE = 'https://example.test/'

describe('providerIconCandidates', () => {
  it('puts apple-touch-icon first, whatever order the page lists them in', () => {
    const html = `
      <link rel="icon" href="/small.png">
      <link rel="apple-touch-icon" href="/touch.png">
    `

    expect(providerIconCandidates(html, BASE)[0]).toBe('https://example.test/touch.png')
  })

  it('keeps the page order among the icons it declared', () => {
    const html = `
      <link rel="icon" href="/one.png">
      <link rel="shortcut icon" href="/two.ico">
    `

    expect(providerIconCandidates(html, BASE).slice(0, 2)).toEqual([
      'https://example.test/one.png',
      'https://example.test/two.ico',
    ])
  })

  it('ends with the root fallback, even for a page that declared nothing', () => {
    expect(providerIconCandidates('<html><head></head></html>', BASE)).toEqual([
      'https://example.test/favicon.ico',
    ])
  })

  it('resolves a relative href against the page it was found on', () => {
    const html = '<link rel="icon" href="assets/mark.png">'

    expect(providerIconCandidates(html, 'https://example.test/about/index.html')).toContain(
      'https://example.test/about/assets/mark.png',
    )
  })

  it('keeps an absolute href on another host', () => {
    const html = '<link rel="icon" href="https://cdn.example.test/mark.png">'

    expect(providerIconCandidates(html, BASE)).toContain('https://cdn.example.test/mark.png')
  })

  /**
   * The Colony re-serves these bytes from its own domain, so a plaintext hop is
   * one somebody else can rewrite — `avatar-fetch.ts`'s rule, applied here.
   */
  it('drops an http candidate', () => {
    const html = '<link rel="icon" href="http://example.test/mark.png">'

    expect(providerIconCandidates(html, BASE)).not.toContain('http://example.test/mark.png')
  })

  /**
   * `sourceUrl` is what lets a reader of the row ask *where did this come from*,
   * and a data URI answers that with the answer itself.
   */
  it('drops a data: icon rather than decoding it', () => {
    const html = '<link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">'

    expect(providerIconCandidates(html, BASE)).toEqual(['https://example.test/favicon.ico'])
  })

  it('reads a bare and a single-quoted attribute as well as a double-quoted one', () => {
    const html = `
      <link rel=icon href=/bare.png>
      <link rel='apple-touch-icon' href='/single.png'>
    `

    expect(providerIconCandidates(html, BASE).slice(0, 2)).toEqual([
      'https://example.test/single.png',
      'https://example.test/bare.png',
    ])
  })

  it('ignores a link that is not an icon', () => {
    const html = '<link rel="stylesheet" href="/site.css">'

    expect(providerIconCandidates(html, BASE)).toEqual(['https://example.test/favicon.ico'])
  })

  it('lists each address once', () => {
    const html = `
      <link rel="icon" href="/mark.png">
      <link rel="shortcut icon" href="/mark.png">
    `

    const candidates = providerIconCandidates(html, BASE)
    expect(candidates.filter((one) => one.endsWith('/mark.png'))).toHaveLength(1)
  })

  /**
   * A candidate whose type says one thing and whose bytes say another is
   * `sanitiseAvatar`'s to refuse. This function decides nothing on a claim, and
   * an `.ico` that is really a PNG is common enough to be the reason.
   */
  it('keeps an .ico candidate rather than judging it by its extension', () => {
    const html = '<link rel="icon" type="image/x-icon" href="/mark.ico">'

    expect(providerIconCandidates(html, BASE)).toContain('https://example.test/mark.ico')
  })

  it('reads nothing from a page whose head is past the ceiling', () => {
    const padding = '<!--'.padEnd(200_000, 'x')
    const html = `${padding}--><link rel="icon" href="/late.png">`

    expect(providerIconCandidates(html, BASE)).toEqual(['https://example.test/favicon.ico'])
  })
})

describe('providerMonogram', () => {
  it('takes two letters from the registrable label', () => {
    expect(providerMonogramLetters('opentask.ai')).toBe('OP')
    expect(providerMonogramLetters('mail.tm')).toBe('MA')
  })

  /** `www.example.com` and `example.com` are one company, not two. */
  it('ignores a www prefix', () => {
    expect(providerMonogramLetters('www.example.com')).toBe('EX')
  })

  it('skips punctuation inside the label', () => {
    expect(providerMonogramLetters('x-y-z.dev')).toBe('XY')
  })

  it('answers a name with no letters at all rather than drawing nothing', () => {
    expect(providerMonogramLetters('---.com')).toBe('?')
  })

  it('is the same bytes for the same provider, every time', () => {
    expect(providerMonogram('opentask.ai')).toBe(providerMonogram('opentask.ai'))
  })

  it('draws different providers differently', () => {
    expect(providerMonogram('opentask.ai')).not.toBe(providerMonogram('mail.tm'))
  })

  /**
   * The letters are filtered to `[a-z0-9]` before they are drawn, so nothing a
   * provider name contains can close the `<text>` element. Asserted rather than
   * argued, because the filter is the kind of thing a later change relaxes.
   */
  it('cannot be made to carry markup through the provider name', () => {
    const drawn = providerMonogram('<script>alert(1)</script>.com')

    expect(drawn).not.toContain('<script')
    expect(drawn).toContain('</svg>')
  })

  /** Decision 5: decoration beside a name that is already text. */
  it('is hidden from a reader that is being read to', () => {
    expect(providerMonogram('opentask.ai')).toContain('aria-hidden="true"')
  })
})

describe('the refresh floor', () => {
  /** `#1405` decision 2 asks for at least seven days, and this is where it is. */
  it('is at least a week', () => {
    expect(PROVIDER_ICON_TTL_DAYS).toBeGreaterThanOrEqual(7)
  })
})
