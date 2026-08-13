import { describe, expect, it } from 'vitest'
import { consoleNavigation } from './navigation.js'
import { page } from './html.js'

/**
 * The navigation `#608` replaced `#431`'s row of links with.
 *
 * The tests below are the criteria that issue lists, in the order it lists them,
 * and the one that matters most is the rejection case: a person without
 * `maintainer` sees **no trace** of the section behind it. Absent, not disabled —
 * a greyed entry tells every visitor there is a door.
 */
describe('the console navigation', () => {
  it('is two levels: sections with items under them, and no third', () => {
    const rendered = consoleNavigation({ maintains: true })

    // Every item is a link inside a list inside a disclosure. A third level
    // would be a <details> inside a <details>, and there is none.
    expect(rendered).toContain('<details')
    expect(rendered).toContain('<summary>')
    expect(rendered).not.toMatch(/<details[^>]*>(?:(?!<\/details>)[\s\S])*<details/)
  })

  it('carries the four sections the issue names, for somebody holding the role', () => {
    const rendered = consoleNavigation({ maintains: true })

    for (const title of ['Your agents', 'Quests', 'Your account', 'Running the Colony']) {
      expect(rendered).toContain(`<summary>${title}</summary>`)
    }
  })

  it('shows no trace of the role-gated section to anybody without the role', () => {
    const rendered = consoleNavigation({})

    expect(rendered).not.toContain('Running the Colony')
    // Not the section, not its items, and not a disabled version of either.
    expect(rendered).not.toContain('/backend')
    expect(rendered).not.toContain('disabled')
    expect(rendered).not.toContain('aria-disabled')
  })

  /**
   * Each section is a page, and `#775` is the issue that made them so. The
   * assertion is on paths rather than anchors precisely because an anchor is
   * what the previous version had: nine links into one path, of which
   * `aria-current` could mark one.
   */
  it('reaches each of /backend’s sections at its own path, with no fragment', () => {
    const rendered = consoleNavigation({ maintains: true })

    for (const path of [
      '/backend',
      '/backend/arrivals',
      '/backend/quests',
      '/backend/moderation',
      '/backend/briefings',
      '/backend/unreported',
      '/backend/tickets',
      '/backend/enquiries',
      '/backend/wanted',
      '/backend/atlas',
      '/backend/settings',
    ]) {
      expect(rendered).toContain(`href="${path}"`)
    }

    expect(rendered).not.toContain('href="/backend#')
  })

  /**
   * The defect `#775` names, asserted from the reader's side: on a section that
   * is not the first, the navigation says where they are. Before the split this
   * was reachable for `/backend` alone.
   */
  it('marks whichever backend section is being read', () => {
    const rendered = consoleNavigation({ current: '/backend/settings', maintains: true })

    expect(rendered).toContain('<a href="/backend/settings" aria-current="page">')
    expect([...rendered.matchAll(/aria-current="page"/g)]).toHaveLength(1)
    expect(rendered).toContain('<details open><summary>Running the Colony</summary>')
  })

  it('marks the current page with aria-current, and marks only it', () => {
    const rendered = consoleNavigation({ current: '/sessions', maintains: true })

    expect(rendered).toContain('<a href="/sessions" aria-current="page">')
    expect([...rendered.matchAll(/aria-current="page"/g)]).toHaveLength(1)
  })

  it('opens the section the current page is in, and leaves the rest shut', () => {
    const rendered = consoleNavigation({ current: '/sessions' })

    // `Your account` holds /sessions; the other two are closed.
    expect(rendered).toContain('<details open><summary>Your account</summary>')
    expect(rendered).toContain('<details><summary>Your agents</summary>')
    expect([...rendered.matchAll(/<details open>/g)]).toHaveLength(1)
  })

  it('opens Running the Colony on its landing page', () => {
    const rendered = consoleNavigation({ current: '/backend', maintains: true })

    expect(rendered).toContain('<details open><summary>Running the Colony</summary>')
    expect(rendered).toContain('<a href="/backend" aria-current="page">')
  })

  it('adds no JavaScript', () => {
    const rendered = consoleNavigation({ maintains: true })

    expect(rendered).not.toMatch(/<script\b/)
    expect(rendered).not.toMatch(/\bon[a-z]+=/)
    expect(rendered).not.toContain('javascript:')
  })
})

describe('the navigation on a page', () => {
  /**
   * `#608`: *"every console page renders the same navigation, from one
   * definition."* Two different pages, one string — asserted against the
   * navigation's own output rather than against a copy of the markup, so this
   * cannot pass by both pages being wrong in the same way.
   */
  it('is the same on every page, from one definition', () => {
    const nav = { maintains: true }
    const one = page({ title: 'One', body: '<p>one</p>', signedIn: true, nav })
    const two = page({ title: 'Two', body: '<p>two</p>', signedIn: true, nav })

    const expected = consoleNavigation(nav)
    expect(one).toContain(expected)
    expect(two).toContain(expected)
  })

  /**
   * *"A sign-out inside a collapsible section is a sign-out people cannot
   * find."* So it is in the top bar and not in the navigation — and reachable
   * without opening anything, which is what the assertion is really about.
   */
  it('shows the sign-out without anything having to be opened', () => {
    const rendered = page({ title: 'A page', body: '<p>x</p>', signedIn: true, nav: {} })

    expect(consoleNavigation({})).not.toContain('/sign-out')
    expect(rendered).toContain('<form method="post" action="/sign-out">')
    /**
     * Before the navigation in the document, and outside every disclosure.
     *
     * The needle is `<details><summary>` and not `<details`: the inline
     * stylesheet carries a comment mentioning the element, so the obvious
     * needle matches inside `<style>` and the assertion measures nothing. Same
     * trap `mark.test.ts` documents for the class name.
     */
    expect(rendered.indexOf('action="/sign-out"')).toBeLessThan(
      rendered.indexOf('<details><summary>'),
    )
  })

  it('renders no navigation at all for a reader with no session', () => {
    const stranger = page({ title: 'A page', body: '<p>x</p>' })

    // The class name is in the inline stylesheet on every page, so the needle
    // has to be the element.
    expect(stranger).not.toContain('<nav class="console-nav"')
    expect(stranger).not.toContain('/sign-out')
    expect(stranger).toContain('<p>x</p>')
  })
})
