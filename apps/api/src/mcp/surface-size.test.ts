import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { AUTHENTICATED_TOOLS, WARDEN_TOOLS, UNAUTHENTICATED_TOOLS } from '../mcp.js'
import { GRAMMAR_RECORD } from './catalogue-budget.js'
import {
  BYTES_PER_TOKEN,
  measureToolList,
  renderSurfaceReport,
  type SurfaceMeasurement,
} from './surface-size.js'

/**
 * Weigh every tier through a real client over a real transport (`#388`).
 *
 * **This is the measurement itself and not a rehearsal of it.** The workflow
 * runs this file with {@link REPORT_PATH} set and reads what it writes, so the
 * number a reviewer sees is produced by the same connect-and-list a citizen
 * performs — not by a fixture of what the list is believed to contain, and not
 * against production with a credential in CI.
 *
 * It lives in the suite rather than beside it because the alternative is a
 * script that imports `__fixtures__`, and fixtures are deliberately kept out of
 * `dist` (`scripts/check-dist.mjs`). A measurement that had to be built
 * differently from the thing it measures would be the defect this exists to
 * prevent.
 */

/** Where the workflow asks for the JSON. Unset in an ordinary run, and then nothing is written. */
const REPORT_PATH = process.env['MCP_SURFACE_REPORT']

const measureTiers = async (): Promise<SurfaceMeasurement[]> => {
  const measured: SurfaceMeasurement[] = []

  const stranger = await anonymousClient()
  measured.push(measureToolList('unauthenticated', (await stranger.client.listTools()).tools))
  await stranger.close()

  const { colony, apiKey } = await registeredCitizen()

  const citizen = await connectedClient(colony, `Bearer ${apiKey}`)
  measured.push(measureToolList('authenticated', (await citizen.client.listTools()).tools))
  await citizen.close()

  const warden = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
  measured.push(measureToolList('warden', (await warden.client.listTools()).tools))
  await warden.close()

  return measured
}

describe('the size of the surface a citizen is handed at connect', () => {
  it('reports each tier the server actually serves, separately', async () => {
    const measured = await measureTiers()

    expect(measured.map((tier) => tier.tier)).toEqual([
      'unauthenticated',
      'authenticated',
      'warden',
    ])

    /**
     * **Against the tool-list construction, not against a snapshot.** A
     * hard-coded byte count would have to be edited by every change that moves
     * it, which makes it a chore rather than a check — and a chore is edited to
     * whatever the run printed. What is asserted is the relationship the tiers
     * are built on: each tier serves what the one below it serves and more.
     */
    /**
     * Registered *is* offered again (`#920`). `#890` left eight account setters
     * registered-but-filtered, and this assertion carried the difference as a
     * `- hidden` term; the eight are gone, so the relationship is the plain one
     * the tiers were always meant to have. A future consolidation that hides a
     * name again is what puts a term back here — and having to put it back is
     * the point, because a hidden name is a thing a reader of this file should
     * have to be told about.
     */
    const [stranger, citizen, warden] = measured
    expect(stranger?.tools).toBe(UNAUTHENTICATED_TOOLS.length)
    expect(citizen?.tools).toBe(UNAUTHENTICATED_TOOLS.length + AUTHENTICATED_TOOLS.length)
    expect(warden?.tools).toBe(
      UNAUTHENTICATED_TOOLS.length + AUTHENTICATED_TOOLS.length + WARDEN_TOOLS.length,
    )

    for (const tier of measured) {
      expect(tier.bytes).toBeGreaterThan(0)
      expect(tier.tokens).toBe(Math.round(tier.bytes / BYTES_PER_TOKEN))
      expect(tier.byWeight).toHaveLength(tier.tools)
      // Every tool's own weight is a share of the tier's, so the parts cannot
      // exceed the whole and no tool can be free.
      expect(tier.byWeight.every((tool) => tool.bytes > 0)).toBe(true)
      expect(tier.byWeight.reduce((sum, tool) => sum + tool.bytes, 0)).toBeLessThanOrEqual(
        tier.bytes,
      )
    }

    if (REPORT_PATH !== undefined && REPORT_PATH !== '') {
      await mkdir(dirname(REPORT_PATH), { recursive: true })
      await writeFile(REPORT_PATH, JSON.stringify(measured, null, 2), 'utf8')
    }
  })

  it('weighs the description and the schema of a tool separately', async () => {
    const measured = await measureTiers()
    const citizen = measured.find((tier) => tier.tier === 'authenticated')

    expect(citizen).toBeDefined()
    for (const tool of citizen?.byWeight ?? []) {
      expect(tool.descriptionBytes + tool.schemaBytes).toBeLessThanOrEqual(tool.bytes)
    }
  })

  /**
   * **`#388` asked this to say it was not a gate, and `#1118` is the deliberate
   * decision the old version of this comment demanded.**
   *
   * What stood here asserted the report contained the words *Nothing here is a
   * gate*, so that a threshold added in a hurry would fail a test rather than
   * merge. The comment said in as many words that a later change wanting a gate
   * had to be a decision with an issue behind it. It is: the report ran for ten
   * days, the catalogue grew from 96 tools to 101 while it ran, and `#1118`
   * closed the gap between the number and anything happening.
   *
   * So what is asserted is the other half of the same discipline. This file
   * still renders and never refuses — {@link renderSurfaceReport} returns a
   * string for a surface twice the size, with no verdict in the return type and
   * nothing to catch — and the report now says where the comparison that *does*
   * refuse actually lives. A reader who is told a run failed and cannot find
   * what failed it is the failure mode a gate has and a report does not.
   */
  it('renders a surface that grew, and names what holds it', async () => {
    const measured = await measureTiers()
    const citizen = measured.find((tier) => tier.tier === 'authenticated')
    expect(citizen).toBeDefined()
    if (citizen === undefined) return

    const doubled = measureToolList('authenticated', [
      ...citizen.byWeight.map((tool) => ({ name: tool.name, description: 'x'.repeat(tool.bytes) })),
    ])

    expect(doubled.bytes).toBeGreaterThan(citizen.bytes)

    const report = renderSurfaceReport([doubled], [citizen])
    expect(report).toMatch(/\| \+[\d,]+ \|/)
    // Where the floor is, and the one sentence that gets it raised. Both have to
    // survive, or the failure arrives without the way out.
    expect(report).toContain('catalogue-budget.json')
    expect(report).toContain(GRAMMAR_RECORD)
    // The old promise is gone, and it stays gone.
    expect(report).not.toContain('Nothing here is a gate')
  })

  it('renders each tier as its own row, and never one total', () => {
    const report = renderSurfaceReport(
      [
        measureToolList('unauthenticated', [{ name: 'kolonie.about', description: 'a' }]),
        measureToolList('authenticated', [
          { name: 'kolonie.about', description: 'a' },
          { name: 'kolonie.me', description: 'b' },
        ]),
      ],
      [measureToolList('authenticated', [{ name: 'kolonie.about', description: 'a' }])],
    )

    expect(report).toContain('`unauthenticated`')
    expect(report).toContain('`authenticated`')
    // The tier with no baseline says so rather than reporting a delta against nothing.
    expect(report).toMatch(/\| `unauthenticated` \|.*\| — \| — \|/)
  })
})
