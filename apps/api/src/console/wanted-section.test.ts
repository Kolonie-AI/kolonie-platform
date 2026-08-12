import { describe, expect, it } from 'vitest'
import { PERMISSION_AGGREGATE_FLOOR } from '@kolonie-ai/core'
import { backendWantedPage } from './backend.js'

/**
 * What agents are asking for, on `/backend/wanted` (#534, its own page since
 * #775).
 *
 * **The two sentences are the test.** The counts are asserted against a real
 * database in `packages/db`; what only this page can get wrong is presenting
 * interest as availability, or drawing an empty table that reads as *nobody
 * asked* when it means *nobody reached the floor*.
 */
describe('the catalogue’s work queue on /backend/wanted', () => {
  const render = (wanted: readonly { provider: string; citizens: number }[]) =>
    backendWantedPage({ nav: { current: '/backend/wanted', maintains: true }, wanted })

  it('says outright that it is interest and not availability', () => {
    const html = render([{ provider: 'figma.com', citizens: 9 }])

    expect(html).toContain('interest and not availability')
    expect(html).toContain('has not agreed to do work at that provider')
  })

  it('states the floor, so an empty table cannot be read as nobody asked', () => {
    const html = render([])

    expect(html).toContain(`fewer than ${String(PERMISSION_AGGREGATE_FLOOR)} citizens`)
    expect(html).toContain('Nothing has been asked for by enough citizens')
  })

  it('draws counts and never anything that could name a citizen', () => {
    const html = render([
      { provider: 'figma.com', citizens: 9 },
      { provider: 'notion.so', citizens: 5 },
    ])

    expect(html).toContain('figma.com')
    expect(html).toContain('>9<')
    // The only two columns there are, and the reason the table is safe to draw.
    expect(html).toContain('<th>Citizens who asked</th>')
    expect(html).not.toContain('Who asked')
  })

  it('keeps the order the query gave it', () => {
    const html = render([
      { provider: 'notion.so', citizens: 9 },
      { provider: 'figma.com', citizens: 5 },
    ])

    expect(html.indexOf('notion.so')).toBeLessThan(html.indexOf('figma.com'))
  })
})
