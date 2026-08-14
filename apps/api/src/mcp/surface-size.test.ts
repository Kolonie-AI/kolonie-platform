import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { AUTHENTICATED_TOOLS, STEWARD_TOOLS, UNAUTHENTICATED_TOOLS } from '../mcp.js'
import { SUPERSEDED_TOOLS } from './superseded.js'
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

  const steward = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
  measured.push(measureToolList('steward', (await steward.client.listTools()).tools))
  await steward.close()

  return measured
}

describe('the size of the surface a citizen is handed at connect', () => {
  it('reports each tier the server actually serves, separately', async () => {
    const measured = await measureTiers()

    expect(measured.map((tier) => tier.tier)).toEqual([
      'unauthenticated',
      'authenticated',
      'steward',
    ])

    /**
     * **Against the tool-list construction, not against a snapshot.** A
     * hard-coded byte count would have to be edited by every change that moves
     * it, which makes it a chore rather than a check — and a chore is edited to
     * whatever the run printed. What is asserted is the relationship the tiers
     * are built on: each tier serves what the one below it serves and more.
     */
    /**
     * A registered tool is not always an offered one (`#890`). The superseded
     * account setters are still in `AUTHENTICATED_TOOLS` — that is what makes
     * them answer — and are filtered out of every list this server sends, so
     * the relationship the tiers are built on holds net of them.
     */
    const hidden = Object.keys(SUPERSEDED_TOOLS).length
    const [stranger, citizen, steward] = measured
    expect(stranger?.tools).toBe(UNAUTHENTICATED_TOOLS.length)
    expect(citizen?.tools).toBe(UNAUTHENTICATED_TOOLS.length + AUTHENTICATED_TOOLS.length - hidden)
    expect(steward?.tools).toBe(
      UNAUTHENTICATED_TOOLS.length + AUTHENTICATED_TOOLS.length + STEWARD_TOOLS.length - hidden,
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
   * **The rejection case `#388` asks for, and it is the important one.**
   *
   * The whole decision was that this reports and never enforces, and the way
   * that decision dies is not by argument — it is by somebody adding a
   * threshold in a hurry because a number looked bad that week. This asserts
   * that a surface twice the size still renders a report and still returns one:
   * there is no verdict in the return type to branch on and no throw to catch.
   *
   * If a later change wants a gate, this test fails, and failing here is the
   * point: it forces the gate to be a deliberate decision with an issue behind
   * it rather than a line nobody reviewed.
   */
  it('reports a surface that grew, and does not refuse it', async () => {
    const measured = await measureTiers()
    const citizen = measured.find((tier) => tier.tier === 'authenticated')
    expect(citizen).toBeDefined()
    if (citizen === undefined) return

    const doubled = measureToolList('authenticated', [
      ...citizen.byWeight.map((tool) => ({ name: tool.name, description: 'x'.repeat(tool.bytes) })),
    ])

    expect(doubled.bytes).toBeGreaterThan(citizen.bytes)

    const report = renderSurfaceReport([doubled], [citizen])
    expect(report).toContain('Nothing here is a gate')
    expect(report).toMatch(/\| \+[\d,]+ \|/)
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
