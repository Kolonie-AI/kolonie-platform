import { describe, expect, it } from 'vitest'
import { monogramLetters, monogramTint, providerMonogram } from './monogram.js'

/**
 * The stand-in a tile draws when the Colony has no icon for a provider
 * (`#1405`).
 *
 * **The fallback is the common case and is tested like one.** Measured
 * 2026-08-22, two of eight sampled providers had a homepage at all — and a
 * homepage is the only place an icon could come from, so most tiles draw this.
 */
describe('the monogram a provider gets when it has no icon', () => {
  /**
   * One letter per part of the name, or two from it if it has only one part —
   * so the same shape of host gets the same treatment. The first draft read
   * `mail.tm` as two parts and `github.com` as one, which is the inconsistency
   * these three lines exist to hold shut.
   */
  it('reads the name as its parts', () => {
    expect(monogramLetters('mail.tm')).toBe('MA')
    expect(monogramLetters('github.com')).toBe('GI')
    expect(monogramLetters('mail.protonmail.ch')).toBe('MP')
  })

  it('ignores www and a port', () => {
    expect(monogramLetters('www.mailbox.org')).toBe('MA')
    expect(monogramLetters('localhost:8080')).toBe('LO')
  })

  /** A host with nothing alphanumeric still gets a mark rather than an empty box. */
  it('always answers with something', () => {
    expect(monogramLetters('...')).not.toBe('')
    expect(monogramLetters('')).toBe('?')
  })

  /**
   * **Deterministic**, which is the whole colour rule: a provider looks the same
   * on every page and across restarts, and adding one changes nobody else's.
   */
  it('gives a host the same tint every time', () => {
    expect(monogramTint('mail.tm')).toBe(monogramTint('mail.tm'))
    expect(monogramTint('mail.tm')).toMatch(/^#[0-9a-f]{6}$/)
  })

  /**
   * The same rules the icon set has (`#1326` decision 7): the provider's name is
   * already text beside this, so the mark says nothing to a reader that is not
   * looking at it, and it carries nothing a page with `default-src 'none'`
   * could not serve.
   */
  it('is decoration, and carries no script and no request', () => {
    const svg = providerMonogram('mail.tm')

    expect(svg).toContain('aria-hidden="true"')
    expect(svg).toContain('focusable="false"')
    expect(svg).not.toContain('<script')
    expect(svg).not.toMatch(/\son[a-z]+=/i)
    expect(svg).not.toContain('href')
    expect(svg).not.toContain('url(')
  })

  it('draws the letters it computed', () => {
    expect(providerMonogram('mail.tm')).toContain('>MA<')
  })
})
