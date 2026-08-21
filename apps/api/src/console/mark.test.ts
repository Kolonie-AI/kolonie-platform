import { describe, expect, it } from 'vitest'
import { CONSOLE_HEADERS, page, signInPage } from './html.js'
import { CONSOLE_MARK, CONSOLE_MAST } from './mark.js'
import { autonomyFormPage } from '../autonomy-page.js'

/**
 * The mark reaches every console page, and it does not cost the CSP (`#498`).
 *
 * **Two halves, and neither covers the other**, exactly as with the palette.
 * This is the local half: is it on the page, is it drawn in tokens, does the
 * strict CSP survive it. **The other half is `scripts/check-mark-drift.mjs`**,
 * which compares the geometry with `kolonie-website/public/mark.svg` and needs
 * that repository in hand, so it runs as a job.
 */

describe('the mark on a console page', () => {
  it('is in the shell, so a page gets it without asking', () => {
    const rendered = page({ title: 'A page', body: '<h1>A page</h1>' })
    expect(rendered).toContain(CONSOLE_MAST)
    expect(rendered).toContain('<svg')
  })

  /**
   * The pages `#498` names specifically, and the reason it names them: they are
   * read by somebody with no session, no account, and no reason to have heard
   * of the Colony. They are also the ones that would have been missed by a
   * change made inside the signed-in branch.
   */
  it.each([
    ['the sign-in page', () => signInPage()],
    [
      'the autonomy form',
      () =>
        autonomyFormPage({
          agentName: 'Vireo',
          action: '/operator/autonomy/a-token',
        }),
    ],
    // The operator drop form was the third of these until `#1444` retired the
    // channel — 7 opened, 0 ever filled. What replaces it is the durable
    // operator page, which is covered by its own tests and is not a
    // nobody-is-signed-in page.
  ])('reaches %s, which nobody is signed in to read', (_name, render) => {
    const rendered = render()
    expect(rendered).toContain('console-mast')
    expect(rendered).toContain('<svg')
  })

  it('is above the navigation, not inside it', () => {
    // The navigation renders only for a session. A mark inside it would be a
    // mark on precisely the pages that already know who the Colony is.
    //
    // The needle is the `<nav>` and not the class name: the class name is also
    // in the inline stylesheet, on every page, so the obvious assertion passes
    // and proves nothing.
    const nav = '<nav class="console-nav"'

    const signedIn = page({ title: 'A page', body: '<p>x</p>', signedIn: true, nav: {} })
    expect(signedIn).toContain(nav)
    expect(signedIn.indexOf('<a class="console-mast"')).toBeLessThan(signedIn.indexOf(nav))

    const stranger = page({ title: 'A page', body: '<p>x</p>' })
    expect(stranger).toContain('<a class="console-mast"')
    expect(stranger).not.toContain(nav)
  })
})

describe('what the mark is drawn in', () => {
  it('draws in tokens and in no literal colour', () => {
    // The colour has one source and it is `theme.ts`, which the palette drift
    // check already compares with the website. That is only possible because
    // the SVG is inlined rather than fetched — an `<img>` carries whatever
    // colours the file was generated with.
    expect(CONSOLE_MARK).toContain('var(--k-accent)')
    expect(CONSOLE_MARK).toContain('var(--k-text-strong)')
    expect(CONSOLE_MARK).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(CONSOLE_MARK).not.toMatch(/\b(?:hsla?|rgba?)\(/)
  })

  it('is the untiled cut', () => {
    // The console's ground is `--k-bg`. The favicon's tile would be a dark
    // rounded square drawn on the colour it is already the colour of.
    expect(CONSOLE_MARK).not.toContain('<rect')
  })

  it('says nothing to a screen reader, because the name beside it does', () => {
    expect(CONSOLE_MARK).toContain('aria-hidden="true"')
    expect(CONSOLE_MAST).toContain('Kolonie AI')
  })
})

describe('what it must not have cost', () => {
  /**
   * The whole argument for inlining. `#397` narrowed `img-src` to `'self'` on
   * purpose — no data URI, no third party, nothing a stranger's text could
   * point at — and this is the surface where a stranger is asked for money.
   */
  it('did not widen the CSP to reach another host', () => {
    const csp = CONSOLE_HEADERS['content-security-policy'] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("img-src 'self'")
    expect(csp).not.toContain('kolonie.ai/')
  })

  it('fetches nothing', () => {
    // An `<img>`, a `url(…)` or an `<image href>` would each be a request from
    // a page that currently makes none.
    expect(CONSOLE_MAST).not.toMatch(/<img\b/)
    expect(CONSOLE_MAST).not.toMatch(/url\(/)
    expect(CONSOLE_MAST).not.toMatch(/<image\b/)
  })

  it('adds no script', () => {
    expect(CONSOLE_MAST).not.toMatch(/<script\b/)
    expect(CONSOLE_MAST).not.toMatch(/\bon[a-z]+=/)
  })
})
