import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { AUTHENTICATED_TOOLS, WARDEN_TOOLS, UNAUTHENTICATED_TOOLS } from '../mcp.js'
import {
  BYTES_PER_TOKEN,
  measureToolList,
  renderSurfaceReport,
  type SurfaceMeasurement,
} from './surface-size.js'

/**
 * The record a floor raise used to have to name, spelled out here because the
 * module that exported it is gone with the floor (`#1649`).
 *
 * **The rule it names is not gone** — the catalogue still encodes grammar and
 * never vocabulary, and `AGENTS.md` §3 still asks for it. What went is the
 * check that made a commit message say the words. So this is a string a test
 * asserts is *absent* from the report, and grepping the repository for the slug
 * should find the prose that cites it rather than an enforcement that no longer
 * exists.
 */
const GRAMMAR_RECORD = 'the-catalogue-encodes-grammar-never-vocabulary'

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
   * **The promise `#388` made, taken away by `#1118` and given back by
   * `#1649`.**
   *
   * `#388` asserted the report contained the words *Nothing here is a gate*, so
   * that a threshold added in a hurry would fail a test rather than merge, and
   * said in as many words that a later change wanting a gate had to be a
   * decision with an issue behind it. `#1118` was that decision and this case
   * asserted the opposite for five weeks: where the floor lived, and the
   * sentence that raised it.
   *
   * `#1649` (D-137) is the decision that reverses it, on the ground the floor
   * could not answer — it raised itself on every merge, so it recorded growth
   * and never held it, and charged a queue round trip per merge for the record.
   *
   * So the assertion is back the way `#388` wrote it, and it is worth more the
   * second time: what it now guards is not an untested promise but one the
   * Colony has already broken once and decided about in the open. A gate
   * reintroduced here fails this test, and the way past it is a maintainer
   * decision reversing D-137 rather than an edit to this line.
   */
  it('renders a surface that grew, and refuses to hold it', async () => {
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
    // The promise itself, and the decision that has to be reversed to remove it.
    expect(report).toContain('Nothing here is a gate')
    expect(report).toContain('D-137')
    // The floor and the sentence that raised it are gone, and stay gone.
    expect(report).not.toContain('catalogue-budget.json')
    expect(report).not.toContain(GRAMMAR_RECORD)
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
