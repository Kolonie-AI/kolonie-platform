import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import {
  budgetVerdict,
  GRAMMAR_RECORD,
  raiseIsJustified,
  type CatalogueBudget,
} from './catalogue-budget.js'
import { measureCatalogue, type PublishedTool } from './catalogue-size.js'

/**
 * The ratchet, checked against the catalogue this build actually serves (`#889`).
 *
 * **Why the floor is measured here and not against the deployment.** `#888`
 * measures `mcp.kolonie.ai`, which is the honest number for an argument about
 * what citizens load. A gate cannot use it: CI has no deployment to reach and no
 * credential to reach one with, and a check that needs both is a check that gets
 * disabled the first week it is flaky. So this weighs the same catalogue built
 * from the suite's own dependencies — no database, no credential, no network —
 * and the two figures are allowed to differ while a release is in flight. What
 * this gate is for is the *diff*: the pull request adding a tool trips it before
 * the tool is ever deployed, which is the only moment the growth is cheap to
 * refuse.
 *
 * On 2026-08-14 they did not differ at all — this suite and `mcp.kolonie.ai`
 * both served 97 tools and 160,346 bytes, so the floor `#888` argued from and
 * the floor this gate holds are the same number. Expect that to come apart
 * between a merge and a deploy, and do not build anything on it.
 *
 * It lives in the suite rather than in a script for the reason `surface-size.ts`
 * gives: fixtures are deliberately kept out of `dist` (`scripts/check-dist.mjs`),
 * so a script would have to build the server differently from the way it is
 * served, and a measurement built differently from its subject is the defect the
 * measurement exists to prevent. `scripts/check-catalogue-budget.mjs` runs this
 * file with {@link REPORT_PATH} set and reads what it writes.
 */

/** Where the check asks for the JSON. Unset in an ordinary run, and then nothing is written. */
const REPORT_PATH = process.env['CATALOGUE_BUDGET_REPORT']

/**
 * The floor, read as data rather than imported as a module.
 *
 * `resolveJsonModule` would put the file in the api's build graph and its
 * contents in `dist`, which makes a number the check rewrites into a build
 * artefact. It is data for a gate, so it is read like data.
 */
const BUDGET_PATH = join(new URL('.', import.meta.url).pathname, 'catalogue-budget.json')
const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) as CatalogueBudget

/** The catalogue a connected citizen is handed — the tier the budget is about. */
const servedCatalogue = async (): Promise<readonly PublishedTool[]> => {
  const { colony, apiKey } = await registeredCitizen()
  const citizen = await connectedClient(colony, `Bearer ${apiKey}`)

  try {
    return (await citizen.client.listTools()).tools as readonly PublishedTool[]
  } finally {
    await citizen.close()
  }
}

describe('the committed budget', () => {
  it('carries the date and the command that produced it', () => {
    // AGENTS.md §7: a measurement without its provenance is a number somebody
    // typed. The floor moves by hand, so this is the only thing standing between
    // a reader and a figure with no history.
    expect(budget.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(budget.command).toContain('check-catalogue-budget.mjs')
    expect(budget.tools).toBeGreaterThan(0)
    expect(budget.bytes).toBeGreaterThan(0)
  })
})

describe('a measurement against the floor', () => {
  it('passes when it is exactly the floor, and reports no headroom', () => {
    const verdict = budgetVerdict({ tools: budget.tools, bytes: budget.bytes }, budget)

    expect(verdict.within).toBe(true)
    expect(verdict.direction).toBe('at')
    expect(verdict.tools).toBe(0)
    expect(verdict.bytes).toBe(0)
  })

  /**
   * **The rejection case `#889` asks for: a stub tool must fail the check.**
   *
   * One tool, with the shortest description anybody would write, is the cheapest
   * growth there is — and it is the shape every namespace arrived in. If the
   * ratchet does not catch this it catches nothing, because nobody adds a
   * catalogue at once.
   */
  it('fails on one added stub tool', () => {
    const stub: PublishedTool = { name: 'kolonie.stub', description: 'A stub.' }
    const measured = measureCatalogue([stub])

    const verdict = budgetVerdict(
      { tools: budget.tools + measured.tools, bytes: budget.bytes + measured.bytes },
      budget,
    )

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('over')
    expect(verdict.tools).toBe(1)
    expect(verdict.bytes).toBeGreaterThan(0)
    // The message has to name the way out, or the next author's cheapest move is
    // to edit the number.
    expect(verdict.message).toContain(GRAMMAR_RECORD)
    expect(verdict.message).toContain('`kind`')
  })

  it('fails on prose that grew without the tool count moving', () => {
    // A consolidation that removes a tool and moves its prose onto the survivors
    // has saved nothing. A count-only budget would call it a win.
    const verdict = budgetVerdict({ tools: budget.tools, bytes: budget.bytes + 9_000 }, budget)

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('over')
    expect(verdict.tools).toBe(0)
    expect(verdict.bytes).toBe(9_000)
  })

  /**
   * **Shrinking fails too, and that is the ratchet rather than a bug.**
   *
   * A saving nobody records is one the next feature spends without anybody
   * noticing it was spent. The cost is one command after a consolidation, and
   * the message is required to name it.
   */
  it('fails when the catalogue shrank and the floor did not follow', () => {
    const verdict = budgetVerdict({ tools: budget.tools - 3, bytes: budget.bytes - 4_000 }, budget)

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('under')
    expect(verdict.tools).toBe(-3)
    expect(verdict.bytes).toBe(-4_000)
    expect(verdict.message).toContain('--write')
  })
})

describe('raising the floor', () => {
  it('accepts a commit that names the record and what the tools are vocabulary-free for', () => {
    expect(
      raiseIsJustified(
        'Two tools for the settlement verbs\n\n' +
          `Budget raised by hand: ${GRAMMAR_RECORD}. Both are vocabulary-free — ` +
          'they add verbs the Colony did not have, and a new settlement kind still costs zero tools.',
      ),
    ).toBe(true)
  })

  it('is case-insensitive, because a commit subject is written by a person', () => {
    expect(
      raiseIsJustified(`See ${GRAMMAR_RECORD.toUpperCase()} — the new tools are VOCABULARY-FREE.`),
    ).toBe(true)
  })

  /** The rejection case: the ordinary way a floor moves is with no sentence at all. */
  it('refuses a commit that only moves the number', () => {
    expect(raiseIsJustified('Update the catalogue budget')).toBe(false)
    expect(raiseIsJustified('Add two tools\n\nBudget bumped to keep CI green.')).toBe(false)
  })

  it('refuses a commit that names the record but not what the tools buy', () => {
    // Naming the record is the cheap half. The record's own acceptance test is
    // the word this insists on, so half a citation is not a justification.
    expect(raiseIsJustified(`Raise the budget, see ${GRAMMAR_RECORD}`)).toBe(false)
  })
})

describe('the catalogue this build serves', () => {
  it('is within its committed budget', async () => {
    const tools = await servedCatalogue()
    const measured = measureCatalogue(tools)
    const verdict = budgetVerdict(measured, budget)

    if (REPORT_PATH !== undefined && REPORT_PATH !== '') {
      // Written before the assertion on purpose: `--write` needs the figure most
      // in exactly the run where the check fails.
      await mkdir(dirname(REPORT_PATH), { recursive: true })
      await writeFile(
        REPORT_PATH,
        JSON.stringify({ tools: measured.tools, bytes: measured.bytes }, null, 2),
        'utf8',
      )
    }

    expect(verdict.message).toBeTruthy()
    expect(verdict.within, verdict.message).toBe(true)
  })
})
