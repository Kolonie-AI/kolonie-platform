import { describe, expect, it } from 'vitest'
import { PERMISSION_AGGREGATE_FLOOR } from '@kolonie-ai/core'
import { backendPage } from './backend.js'

/**
 * What agents are asking for, on `/backend` (#534).
 *
 * **The two sentences are the test.** The counts are asserted against a real
 * database in `packages/db`; what only this page can get wrong is presenting
 * interest as availability, or drawing an empty table that reads as *nobody
 * asked* when it means *nobody reached the floor*.
 */
describe('the catalogue’s work queue on /backend', () => {
  const numbers = {
    accountsByPath: {},
    agentsByRuntime: {},
    modelFamilies: {},
    modelsUndeclared: 0,
    citizens: 0,
    skillsGranted: {},
    questsByStatus: {},
    smsYesterdayByCountry: {},
    acceptedQuestReports: { market: 0, intraSwarm: 0 },
    permissionBlocks: [],
    escrowHeld: 0,
    ledgerSum: 0,
    mintBalance: 0,
    computedAt: '2026-08-08T00:00:00.000Z',
  } as never

  const sections = {
    registrations: { rows: [], computedAt: '2026-08-08T00:00:00.000Z' },
    tickets: { rows: [], computedAt: '2026-08-08T00:00:00.000Z' },
  } as never

  const render = (wanted?: readonly { provider: string; citizens: number }[]) =>
    backendPage({
      nav: {},
      numbers,
      sections,
      arrivals: { agents: [], people: [], computedAt: '2026-08-08T00:00:00.000Z' } as never,
      unreported: [],
      settings: [],
      ...(wanted === undefined ? {} : { wanted }),
    })

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
